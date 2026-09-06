// The other half of the #17830 recovery: proof that the reconnect a spawn-time cause triggers is
// the SAME locked deploy repair, not a second rebuild path. `tryAcquireRelayRepairLock` is the only
// thing standing between two clients and a concurrent `node_modules` rewrite, so a lock this path
// cannot take must degrade to the relay's message rather than proceed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RelayInstallMarkerModule from './ssh-relay-install-marker'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+testhash')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn().mockReturnValue('linux-x64'),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn().mockResolvedValue({
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }),
  isUnconfirmedSshCommandTermination: () => false,
  execCommand: vi.fn()
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-install-marker', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayInstallMarkerModule>()),
  createRelayInstallMarkerFileName: () => '.sftp-namespace-00000000000000000000000000000000'
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+testhash'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(true),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))

vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))

vi.mock('./ssh-relay-gc-claim', () => ({
  releaseRelayGcClaimWithRetry: vi.fn().mockResolvedValue('released'),
  tryAcquireRelayGcClaim: vi.fn().mockResolvedValue('launch-token'),
  waitForRelayGcClaimRelease: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import { parseUnameToRelayPlatform } from './relay-protocol'
import { isRelayAlreadyInstalled } from './ssh-relay-versioned-install'
import { tryAcquireRelayRepairLock } from './ssh-relay-repair-lock'
import {
  makeMockConnection,
  type ExecResponse,
  type SftpWriteCapture
} from './ssh-relay-native-deps-install-fixture'
import { forgetRelayNodePtyRepairs, recoverRelayNodePtyForSpawn } from './ssh-relay-node-pty-repair'
import type { TerminalUnavailableCause } from '../../shared/terminal-unavailable-cause'

const TARGET = 'repair-host'

const ABI_MISMATCH: TerminalUnavailableCause = {
  status: 'blocked',
  reason: 'abi_mismatch',
  detail: 'built for NODE_MODULE_VERSION 108, this Node accepts 115',
  repairable: true,
  host: {
    platform: 'linux',
    arch: 'x64',
    libc: 'glibc',
    glibcVersion: '2.31',
    nodeAbi: '115',
    nodeVersion: 'v20.11.0'
  }
}

// The relay dir is complete but node-pty will not load, which is exactly what the spawn-time cause
// describes. @parcel/watcher is healthy, so only node-pty is reset and rebuilt.
// Stdout of the relay-side pty-master cloexec patch, which runs on Linux hosts once a
// freshly installed node-pty loads (#17915).
const NPTY_CLOEXEC_PATCHED = 'ORCA-NPTY-CLOEXEC:patched\n'
const NODE_PTY_BROKEN = 'ORCA-NATIVE-DEPS-MISSING:node-pty\nMISSING'

function repairSucceedsResponses(): ExecResponse[] {
  return [
    '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
    '/home/u',
    NODE_PTY_BROKEN, // health probe before the lock
    NODE_PTY_BROKEN, // re-probe under the repair lock
    '', // SFTP-namespace install-owner marker
    '', // reset node-pty + npm install
    '', // chmod prebuilds
    'ORCA-NPTY-PROBE-OK\n', // node-pty loads again
    '', // rm -f probe stderr
    NPTY_CLOEXEC_PATCHED,
    'DEAD',
    '', // publish the per-launch credential
    'READY'
  ]
}

function lockUnavailableResponses(): ExecResponse[] {
  return [
    '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
    '/home/u',
    NODE_PTY_BROKEN, // health probe before the lock
    'DEAD',
    '', // publish the per-launch credential
    'READY'
  ]
}

describe('spawn-time node-pty repair through the locked deploy path', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  const sftpCapture: SftpWriteCapture = {
    paths: [],
    contents: {},
    execCallCountAtWrite: {}
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
    sftpCapture.paths.length = 0
    for (const key of Object.keys(sftpCapture.contents)) {
      delete sftpCapture.contents[key]
    }
    for (const key of Object.keys(sftpCapture.execCallCountAtWrite)) {
      delete sftpCapture.execCallCountAtWrite[key]
    }
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('linux-x64')
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValue('acquired')
    forgetRelayNodePtyRepairs(TARGET)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    forgetRelayNodePtyRepairs(TARGET)
  })

  function feed(responses: ExecResponse[]): void {
    const mockExec = vi.mocked(execCommand)
    for (const response of responses) {
      if (typeof response === 'string') {
        mockExec.mockResolvedValueOnce(response)
      } else {
        mockExec.mockRejectedValueOnce(new Error(response.reject))
      }
    }
  }

  function recover(conn: ReturnType<typeof makeMockConnection>, deploys: { count: number }) {
    return recoverRelayNodePtyForSpawn({
      targetId: TARGET,
      cause: ABI_MISMATCH,
      hasLivePtys: () => false,
      reconnect: async () => {
        deploys.count += 1
        await deployAndLaunchRelay(conn)
      },
      resolveProvider: () => ({ generation: deploys.count })
    })
  }

  function execCalls(): string[] {
    return vi.mocked(execCommand).mock.calls.map(([, command]) => String(command))
  }

  it('rebuilds node-pty under the repair lock and returns the post-reconnect provider', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(repairSucceedsResponses())
    const deploys = { count: 0 }

    const result = await recover(conn, deploys)

    expect(result.outcome).toBe('repaired')
    expect(result.provider).toEqual({ generation: 1 })
    expect(deploys.count).toBe(1)
    expect(vi.mocked(tryAcquireRelayRepairLock)).toHaveBeenCalledTimes(1)
    const install = execCalls().find((command) => command.includes('npm install')) ?? ''
    expect(install).toContain('npm install')
    // The reset is what makes an ABI-mismatched binding recompile instead of being reported up to date.
    expect(install).toContain("rm -rf 'node_modules/node-pty'")
  })

  it('does not repair or reconnect a second time for the same cause on the same host', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(repairSucceedsResponses())
    const deploys = { count: 0 }
    await recover(conn, deploys)
    vi.mocked(execCommand).mockReset().mockResolvedValue('')

    const second = await recover(conn, deploys)

    expect(second.outcome).toBe('already-attempted')
    expect(second.provider).toBeNull()
    expect(deploys.count).toBe(1)
    expect(execCalls()).toEqual([])
    expect(vi.mocked(tryAcquireRelayRepairLock)).toHaveBeenCalledTimes(1)
  })

  it.each(['busy', 'error'] as const)(
    'leaves the host untouched and degrades to the relay message when the repair lock is %s',
    async (lockResult) => {
      const conn = makeMockConnection(sftpCapture)
      vi.mocked(tryAcquireRelayRepairLock).mockResolvedValue(lockResult)
      feed(lockUnavailableResponses())
      const deploys = { count: 0 }

      const result = await recover(conn, deploys)

      // The reconnect happened; the rebuild did not, so the retried spawn hits the same relay
      // rejection and the user reads today's message. Nothing wrote to node_modules unlocked.
      expect(deploys.count).toBe(1)
      expect(execCalls().some((command) => command.includes('npm install'))).toBe(false)
      expect(execCalls().some((command) => command.includes('node_modules/node-pty'))).toBe(false)
      expect(result.outcome).toBe('repaired')
      const warnings = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
      expect(warnings.some((line) => line.includes(`repair lock is ${lockResult}`))).toBe(true)
    }
  )

  it('never reaches the deploy path for an unverifiable cause', async () => {
    const conn = makeMockConnection(sftpCapture)
    const deploys = { count: 0 }

    const result = await recoverRelayNodePtyForSpawn({
      targetId: TARGET,
      cause: { ...ABI_MISMATCH, status: 'unverifiable' },
      hasLivePtys: () => false,
      reconnect: async () => {
        deploys.count += 1
        await deployAndLaunchRelay(conn)
      },
      resolveProvider: () => ({ generation: deploys.count })
    })

    expect(result.outcome).toBe('not-repairable')
    expect(deploys.count).toBe(0)
    expect(vi.mocked(tryAcquireRelayRepairLock)).not.toHaveBeenCalled()
    expect(execCalls()).toEqual([])
  })

  it('never reaches the deploy path for a toolchain_missing cause', async () => {
    const conn = makeMockConnection(sftpCapture)
    const deploys = { count: 0 }

    const result = await recoverRelayNodePtyForSpawn({
      targetId: TARGET,
      cause: { ...ABI_MISMATCH, reason: 'toolchain_missing', repairable: false },
      hasLivePtys: () => false,
      reconnect: async () => {
        deploys.count += 1
        await deployAndLaunchRelay(conn)
      },
      resolveProvider: () => ({ generation: deploys.count })
    })

    expect(result.outcome).toBe('not-repairable')
    expect(deploys.count).toBe(0)
    expect(execCalls()).toEqual([])
  })
})
