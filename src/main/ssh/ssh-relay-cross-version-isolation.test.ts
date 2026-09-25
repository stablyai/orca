// Cross-version isolation guard.
//
// Why: this test is the executable form of the "Pattern Note" in
// docs/ssh-relay-versioned-install-dirs.md — it asserts that a v2 deploy
// targeting a remote where a v1 daemon is already running NEVER touches
// v1's install dir or socket. Without this test a future refactor that
// collapses to a shared dir passes every other unit test and re-introduces
// the original "stale daemon serves new client" bug.

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RelayInstallMarkerModule from './ssh-relay-install-marker'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+222222222222')
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

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'

function makeMockConnection(): SshConnection {
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(false),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    // Why: production attaches and removes real SFTP/write-stream listeners, so the fake must be an emitter.
    sftp: vi.fn().mockImplementation(() => {
      const sftp = new EventEmitter()
      return Promise.resolve(
        Object.assign(sftp, {
          mkdir: vi.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
          // Shell home and SFTP start directory agree here, so no namespace redirect applies.
          realpath: vi.fn((_p: string, cb: (err: Error | null, resolved: string) => void) =>
            cb(null, '/home/u')
          ),
          lstat: vi.fn((_p: string, cb: (err: Error | null) => void) =>
            cb(Object.assign(new Error('No such file'), { code: 2 }))
          ),
          createWriteStream: vi.fn().mockImplementation(() => {
            const ws = new EventEmitter()
            return Object.assign(ws, {
              end: vi.fn(() => setTimeout(() => ws.emit('close'), 0))
            })
          }),
          end: vi.fn(() => setTimeout(() => sftp.emit('close'), 0))
        })
      )
    })
  } as unknown as SshConnection
}

describe('cross-version isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a v2 deploy never references the v1 install dir or v1 socket path', async () => {
    const conn = makeMockConnection()
    const mockExec = vi.mocked(execCommand)

    // Simulated remote where:
    //   v1 dir = ~/.orca-remote/relay-0.1.0+111111111111/  (live daemon, listening)
    //   v2 dir = ~/.orca-remote/relay-0.1.0+222222222222/  (does not yet exist)
    // The v2 client has fullVersion='0.1.0+222222222222' (from the fs mock above).
    //
    mockExec.mockImplementation((_conn, command) => {
      if (command.includes('__ORCA_UPLOAD_STAGE_SLOT__')) {
        return Promise.resolve(
          '__ORCA_UPLOAD_STAGE_SLOT__.sftp-namespace-00000000000000000000000000000000:slot-0'
        )
      }
      if (command.includes('__ORCA_UPLOAD_STAGE_PROMOTION__')) {
        return Promise.resolve(
          '__ORCA_UPLOAD_STAGE_PROMOTION__.sftp-namespace-00000000000000000000000000000000:PROMOTED'
        )
      }
      if (command.includes('__ORCA_REMOTE_PLATFORM__')) {
        return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      }
      if (command === 'echo $HOME') {
        return Promise.resolve('/home/u')
      }
      if (command.includes("-name 'relay-0.1.0+222222222222.upload-*'")) {
        return Promise.resolve('')
      }
      if (command.includes('relay-watcher.js') && command.includes('.install-complete')) {
        return Promise.resolve('MISSING')
      }
      if (command.includes('.gc-claim') && command.includes('echo LOCKED || echo OPEN')) {
        return Promise.resolve('OPEN')
      }
      if (command.startsWith('if mkdir ') && command.includes('.install-lock')) {
        return Promise.resolve('OK')
      }
      if (command.includes('ORCA-NPTY-PROBE-OK')) {
        return Promise.resolve('ORCA-NPTY-PROBE-OK\n')
      }
      if (command.includes('process.stdout.write("READY")')) {
        return Promise.resolve('READY')
      }
      if (command.includes('test -S') && command.includes('echo ALIVE || echo DEAD')) {
        return Promise.resolve('DEAD')
      }
      if (command.includes('__ORCA_RELAY_GC_FIND_STATUS__')) {
        return Promise.resolve('relay-0.1.0+111111111111\nrelay-0.1.0+222222222222\n')
      }
      if (command.includes('relay-0.1.0+111111111111/.install-lock')) {
        return Promise.resolve('OPEN')
      }
      if (command.includes('relay-0.1.0+111111111111/.install-complete')) {
        return Promise.resolve('COMPLETE')
      }
      if (command.includes('relay-0.1.0+111111111111') && command.includes('relay-*.sock')) {
        return Promise.resolve('ALIVE')
      }
      return Promise.resolve('')
    })

    await deployAndLaunchRelay(conn)
    await vi.waitFor(() =>
      expect(mockExec.mock.calls.some(([, command]) => command.includes('relay-*.sock'))).toBe(true)
    )

    const allCmds = [
      ...mockExec.mock.calls.map(([, c]) => c),
      ...vi.mocked(conn.exec).mock.calls.map(([c]) => c as string)
    ]

    // (a) the v2 deploy creates dirs/files under its content-hashed directory
    expect(allCmds.some((c) => c.includes('relay-0.1.0+222222222222'))).toBe(true)

    // (b) the v2 launch and connect socket paths are rooted in v2 dir, never v1
    const launchAndConnectCmds = vi
      .mocked(conn.exec)
      .mock.calls.map(([c]) => c as string)
      .filter((c) => c.includes('--sock-path'))
    expect(launchAndConnectCmds.length).toBeGreaterThan(0)
    for (const cmd of launchAndConnectCmds) {
      expect(cmd).toContain('relay-0.1.0+222222222222')
      expect(cmd).not.toContain('relay-0.1.0+111111111111')
    }

    // (c) GC observes v1 has a live socket and never issues an rm -rf for it
    const v1RemoveCmds = allCmds.filter(
      (c) => c.includes('rm -rf') && c.includes('relay-0.1.0+111111111111')
    )
    expect(v1RemoveCmds).toHaveLength(0)

    // (d) blanket isolation: every command that mentions v1hash MUST be a
    // GC liveness probe (`ls`, `test -d`, `test -f`, or `for f in .../*.sock`)
    // — never a write, mkdir, chmod, touch, rm, node launch, or socket poll.
    // This prevents a future refactor that accidentally writes to the v1 dir
    // (e.g. shared install-complete, upload over symlink) from passing.
    const v1Refs = allCmds.filter((c) => c.includes('relay-0.1.0+111111111111'))
    for (const cmd of v1Refs) {
      const isReadOnlyProbe =
        /^\s*ls\b/.test(cmd) ||
        /\btest -d\b/.test(cmd) ||
        /\btest -e\b/.test(cmd) ||
        /\btest -f\b/.test(cmd) ||
        /\btest -S\b/.test(cmd) ||
        /\bfor f in .*\.sock\b/.test(cmd)
      expect(isReadOnlyProbe, `unexpected v1 reference: ${cmd}`).toBe(true)
    }
  })
})
