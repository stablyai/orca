import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
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
import {
  makeExecResponses,
  makeStagedFirstInstallExecPrefix,
  makeMockConnection,
  type ExecResponse,
  type SftpWriteCapture
} from './ssh-relay-native-deps-install-fixture'

describe('installNativeDeps staged uploads', () => {
  const sftpCapture: SftpWriteCapture = {
    paths: [],
    contents: {},
    execCallCountAtWrite: {}
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
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

  it('exports the host Node headers dir to node-gyp on every command that can compile node-pty (STA-6674)', async () => {
    const conn = makeMockConnection(sftpCapture)
    // Install succeeds, the probe fails, the rebuild repairs it, then the cloexec patch rebuilds again.
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'missing', repairProbe: 'ok' }))

    await deployAndLaunchRelay(conn)

    const commands = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
    const compiling = ['npm install', 'npm rebuild', 'node-pty-1.1.0-master-cloexec-patch.cjs']
    for (const compileStep of compiling) {
      const command = commands.find((candidate) => candidate.includes(compileStep))
      expect(command, compileStep).toBeDefined()
      // Both spellings: node-gyp 10 (Node 20) reads only npm_config_, node-gyp >= 11.4 prefers the other.
      expect(command).toContain('export npm_config_nodedir=')
      expect(command).toContain('npm_package_config_node_gyp_nodedir=')
      // The export precedes the compile on the same command line, and only when the probe found headers.
      expect(command!.indexOf('npm_config_nodedir')).toBeLessThan(command!.indexOf(compileStep))
      expect(command).toContain('node_version.h')
      // The marker lands in the captured output, so a failure after it can say what was exported.
      expect(command).toContain('echo "ORCA-NODE-HEADERS:${ORCA_NODE_HEADERS_DIR:-none}"')
    }
  })

  // What execCommand actually rejects with: the whole command line (marker echo included) quoted
  // ahead of the host's output. A fixture that omits the command hides the marker-parsing bug.
  function rejectNpmInstallLikeExecCommand(hostOutput: string): void {
    vi.mocked(execCommand).mockImplementationOnce(async (_conn, command) => {
      throw new Error(`Command "${command}" failed (exit 1): ${hostOutput}`)
    })
  }
  const HEADERS_REFUSED =
    'npm error gyp http fetch GET https://nodejs.org/download/release/v24.12.0/node-v24.12.0-headers.tar.gz attempt 1 failed with ECONNREFUSED\nnpm error gyp ERR! configure error'

  it('names the fix when node-gyp cannot download headers and the host ships none (STA-6674)', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(makeStagedFirstInstallExecPrefix())
    rejectNpmInstallLikeExecCommand(`ORCA-NODE-HEADERS:none\n${HEADERS_REFUSED}`)
    feed(['']) // clean stage root

    const error = await deployAndLaunchRelay(conn).catch((e: Error) => e)
    expect((error as Error).message).toContain('could not download the Node.js headers')
    expect((error as Error).message).toContain('no local headers matching its own version')
    expect((error as Error).message).not.toContain('Orca defect')
    expect((error as Error).message).toContain('ECONNREFUSED')
    // A full toolchain: the toolchain probe must not run, and this is not a "build tools" error.
    expect((error as Error).message).not.toContain('build tools')
    const commands = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
    expect(commands.some((command) => command.includes('command -v "$t"'))).toBe(false)
  })

  it('reports an Orca defect when headers were exported but node-gyp downloaded anyway', async () => {
    // The marker says the export happened; a download after it means node-gyp never read the env.
    const conn = makeMockConnection(sftpCapture)
    feed(makeStagedFirstInstallExecPrefix())
    rejectNpmInstallLikeExecCommand(`ORCA-NODE-HEADERS:/usr/local\n${HEADERS_REFUSED}`)
    feed(['']) // clean stage root

    const error = await deployAndLaunchRelay(conn).catch((e: Error) => e)
    expect((error as Error).message).toContain('/usr/local/include/node')
    expect((error as Error).message).toContain('Orca defect')
    expect((error as Error).message).not.toContain('no local headers matching its own version')
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
      feed(makeStagedFirstInstallExecPrefix())
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
      .mockResolvedValueOnce(
        '__ORCA_UPLOAD_STAGE_SLOT__.sftp-namespace-00000000000000000000000000000000:slot-0'
      )
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
