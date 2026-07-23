import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn()
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+testhash'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(false),
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
import { execCommand, uploadDirectory } from './ssh-relay-deploy-helpers'
import { RELAY_DEPLOY_TIMEOUT_MS } from './ssh-relay-deploy-timing'
import { parseUnameToRelayPlatform } from './relay-protocol'
import {
  abandonInstall,
  finalizeInstall,
  isRelayAlreadyInstalled
} from './ssh-relay-versioned-install'
import { acquireInstallLock } from './ssh-relay-install-lock'
import type { SshConnection } from './ssh-connection'

type SftpWriteCapture = {
  paths: string[]
  contents: Record<string, string>
  execCallCountAtWrite: Record<string, number>
}

type ExecResponse = string | { reject: string }

function makeMockConnection(capture: SftpWriteCapture): SshConnection {
  const sftpCreate = (): unknown => ({
    mkdir: vi.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
    on: vi.fn(),
    once: vi.fn(),
    createWriteStream: vi.fn().mockImplementation((path: string) => {
      capture.paths.push(path)
      let buf = ''
      let closeCb: (() => void) | undefined
      const stub = {
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'close') {
            closeCb = cb
          }
        }),
        end: vi.fn((data?: string) => {
          if (typeof data === 'string') {
            buf += data
          }
          capture.contents[path] = buf
          capture.execCallCountAtWrite[path] = vi.mocked(execCommand).mock.calls.length
          if (closeCb) {
            setTimeout(closeCb, 0)
          }
        })
      }
      return Object.assign(stub, { once: stub.on })
    }),
    end: vi.fn()
  })
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(false),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    sftp: vi.fn().mockImplementation(() => Promise.resolve(sftpCreate()))
  } as unknown as SshConnection
}

function makeExecResponses(opts: {
  npmInstall: 'ok' | { reject: string }
  probe: 'ok' | 'missing' | 'dir-gone' | { reject: string }
  probeStdoutOverride?: string
  repairProbe?: 'ok' | 'missing'
  toolchainProbe?: string
}): ExecResponse[] {
  if (opts.npmInstall !== 'ok') {
    return [
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      '',
      '',
      '',
      '',
      opts.npmInstall,
      opts.toolchainProbe ?? 'HAVE make\nHAVE g++\nHAVE cc\nHAVE python3\nPKG apt-get'
    ]
  }
  const probeSlot: ExecResponse =
    opts.probeStdoutOverride !== undefined
      ? opts.probeStdoutOverride
      : opts.probe === 'ok'
        ? 'ORCA-NPTY-PROBE-OK\n'
        : opts.probe === 'missing'
          ? 'MISSING\n'
          : opts.probe === 'dir-gone'
            ? { reject: 'cd: no such file or directory' }
            : opts.probe
  const slots: ExecResponse[] = [
    '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
    '/home/u',
    '',
    '',
    '',
    '',
    opts.npmInstall,
    '',
    probeSlot
  ]
  if (typeof probeSlot === 'string') {
    const probeOk = probeSlot.includes('ORCA-NPTY-PROBE-OK')
    if (!probeOk) {
      slots.push('')
    }
    slots.push('')
    if (!probeOk) {
      slots.push('')
      slots.push('')
      const repairProbe = opts.repairProbe === 'ok' ? 'ORCA-NPTY-PROBE-OK\n' : 'MISSING\n'
      slots.push(repairProbe)
      if (!repairProbe.includes('ORCA-NPTY-PROBE-OK')) {
        slots.push('')
      }
      slots.push('')
    }
  }
  slots.push('DEAD', 'READY')
  return slots
}

describe('installNativeDeps staged uploads', () => {
  const sftpCapture: SftpWriteCapture = {
    paths: [],
    contents: {},
    execCallCountAtWrite: {}
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset()
    vi.mocked(uploadDirectory).mockResolvedValue(undefined)
    sftpCapture.paths.length = 0
    for (const key of Object.keys(sftpCapture.contents)) {
      delete sftpCapture.contents[key]
    }
    for (const key of Object.keys(sftpCapture.execCallCountAtWrite)) {
      delete sftpCapture.execCallCountAtWrite[key]
    }
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('linux-x64')
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(false)
  })

  function feed(execResponses: ExecResponse[]): void {
    const mockExec = vi.mocked(execCommand)
    for (const response of execResponses) {
      if (typeof response === 'string') {
        mockExec.mockResolvedValueOnce(response)
      } else {
        mockExec.mockRejectedValueOnce(new Error(response.reject))
      }
    }
  }

  it('writes a hardcoded package.json BEFORE running npm install', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'ok' }))

    await deployAndLaunchRelay(conn)

    const pkgPath = sftpCapture.paths.find((path) => path.endsWith('/package.json'))
    expect(pkgPath, 'package.json must be written via SFTP').toBeTruthy()

    const written = sftpCapture.contents[pkgPath as string]
    expect(written).toBeTruthy()
    const parsed = JSON.parse(written) as Record<string, unknown>
    expect(parsed.name).toBe('orca-relay')
    expect(parsed.version).toBe('1.0.0')
    expect(parsed.private).toBe(true)
    expect(parsed.type).toBe('commonjs')
    expect(parsed.dependencies).toEqual({ '@parcel/watcher': '2.5.6', 'node-pty': '1.1.0' })
    expect(parsed.allowScripts).toEqual({
      '@parcel/watcher@2.5.6': true,
      'node-pty@1.1.0': true
    })

    const execCalls = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
    const npmInstallIdx = execCalls.findIndex(
      (command) =>
        command.includes('npm install') &&
        command.includes('node-pty') &&
        command.includes('@parcel/watcher')
    )
    expect(npmInstallIdx).toBeGreaterThanOrEqual(0)
    expect(execCalls[npmInstallIdx]).toContain('--ignore-scripts=false')
    const writeObservedAt = sftpCapture.execCallCountAtWrite[pkgPath as string]
    expect(writeObservedAt).toBeLessThanOrEqual(npmInstallIdx)
  })

  it('promotes only after the first-install lock is acquired', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'ok' }))
    vi.mocked(acquireInstallLock).mockImplementationOnce(async () => {
      const commands = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
      expect(commands.some((command) => command.includes('cp -a'))).toBe(false)
    })

    await deployAndLaunchRelay(conn)

    const commands = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
    const promotionIndex = commands.findIndex((command) => command.includes('cp -a'))
    const npmIndex = commands.findIndex((command) => command.includes('npm install'))
    expect(promotionIndex).toBeGreaterThanOrEqual(0)
    expect(npmIndex).toBeGreaterThan(promotionIndex)
  })

  it('cleans a staged upload when cancellation wins before lock acquisition', async () => {
    vi.useFakeTimers()
    try {
      const conn = makeMockConnection(sftpCapture)
      feed(['__ORCA_REMOTE_PLATFORM__ Linux x86_64', '/home/u', '', ''])
      vi.mocked(acquireInstallLock).mockImplementationOnce(
        (_conn, _remoteDir, _host, options) =>
          new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true
            })
          })
      )
      vi.mocked(execCommand).mockResolvedValueOnce('')

      const deploy = deployAndLaunchRelay(conn).catch((err: Error) => err)
      await vi.advanceTimersByTimeAsync(RELAY_DEPLOY_TIMEOUT_MS)
      const result = await deploy

      expect(result).toBeInstanceOf(Error)
      expect(vi.mocked(acquireInstallLock)).toHaveBeenCalledTimes(1)
      const commands = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
      expect(commands.some((command) => command.includes('cp -a'))).toBe(false)
      expect(commands.some((command) => command.includes('rm -rf'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains the lock after an unconfirmed promotion termination', async () => {
    const conn = makeMockConnection(sftpCapture)
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/u')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(
        Object.assign(new Error('promotion termination was not confirmed'), {
          sshChannelCloseConfirmed: false
        })
      )
      .mockResolvedValueOnce('')

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(
      'promotion termination was not confirmed'
    )
    expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
  })
})
