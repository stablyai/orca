// Cross-version isolation guard.
//
// Why: this test is the executable form of the "Pattern Note" in
// docs/ssh-relay-versioned-install-dirs.md — it asserts that a v2 deploy
// targeting a remote where a v1 daemon is already running NEVER touches
// v1's install dir or socket. Without this test a future refactor that
// collapses to a shared dir passes every other unit test and re-introduces
// the original "stale daemon serves new client" bug.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+v2hash')
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
  execCommand: vi.fn(),
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'

function makeMockConnection(): SshConnection {
  return {
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    sftp: vi.fn().mockResolvedValue({
      mkdir: vi.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
      on: vi.fn(),
      once: vi.fn(),
      createWriteStream: vi.fn().mockReturnValue({
        on: vi.fn((_event: string, cb: () => void) => {
          if (_event === 'close') {
            setTimeout(cb, 0)
          }
        }),
        once: vi.fn((_event: string, cb: () => void) => {
          if (_event === 'close') {
            setTimeout(cb, 0)
          }
        }),
        end: vi.fn()
      }),
      end: vi.fn()
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
    //   v1 dir = ~/.orca-remote/relay-0.1.0+v1hash/  (live daemon, listening)
    //   v2 dir = ~/.orca-remote/relay-0.1.0+v2hash/  (does not yet exist)
    // The v2 client has fullVersion='0.1.0+v2hash' (from the fs mock above).
    //
    // We feed enough exec results to walk through the deploy: platform,
    // $HOME, isRelayAlreadyInstalled probe, lock acquire, upload (no exec),
    // npm install, finalize, socket probe, socket poll, then GC scan.
    const responses: string[] = [
      'Linux x86_64', // uname -sm
      '/home/u', // echo $HOME
      'MISSING', // isRelayAlreadyInstalled (v2 dir doesn't exist)
      '', // mkdir -p remoteRelayDir (v2)
      'OK', // mkdir lock OK
      'MISSING', // re-probe after lock → still missing → proceed with install
      '', // mkdir remoteDir (uploadRelay)
      '', // chmod +x node
      '', // npm install
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n', // node -e require() load-test (post-install verify)
      '', // rm -f probe-stderr (best-effort cleanup after probe resolved)
      '', // touch .install-complete (finalizeInstall)
      '', // rm -rf .install-lock
      'DEAD', // launch socket probe
      'READY', // socket poll
      // GC scan begins here
      'relay-0.1.0+v1hash\nrelay-0.1.0+v2hash\n', // ls listing
      'OPEN', // v1 lock probe (siblings only — current dir is v2)
      'COMPLETE', // v1 .install-complete probe
      'ALIVE' // v1 socket probe → live → SKIP (don't GC v1)
    ]
    for (const r of responses) {
      mockExec.mockResolvedValueOnce(r)
    }

    await deployAndLaunchRelay(conn)

    const allCmds = [
      ...mockExec.mock.calls.map(([, c]) => c),
      ...vi.mocked(conn.exec).mock.calls.map(([c]) => c as string)
    ]

    // (a) the v2 deploy creates dirs/files under relay-0.1.0+v2hash
    expect(allCmds.some((c) => c.includes('relay-0.1.0+v2hash'))).toBe(true)

    // (b) the v2 launch and connect socket paths are rooted in v2 dir, never v1
    const launchAndConnectCmds = vi
      .mocked(conn.exec)
      .mock.calls.map(([c]) => c as string)
      .filter((c) => c.includes('--sock-path'))
    expect(launchAndConnectCmds.length).toBeGreaterThan(0)
    for (const cmd of launchAndConnectCmds) {
      expect(cmd).toContain('relay-0.1.0+v2hash')
      expect(cmd).not.toContain('relay-0.1.0+v1hash')
    }

    // (c) GC observes v1 has a live socket and never issues an rm -rf for it
    const v1RemoveCmds = allCmds.filter(
      (c) => c.includes('rm -rf') && c.includes('relay-0.1.0+v1hash')
    )
    expect(v1RemoveCmds).toHaveLength(0)

    // (d) blanket isolation: every command that mentions v1hash MUST be a
    // GC liveness probe (`ls`, `test -d`, `test -f`, or `for f in .../*.sock`)
    // — never a write, mkdir, chmod, touch, rm, node launch, or socket poll.
    // This prevents a future refactor that accidentally writes to the v1 dir
    // (e.g. shared install-complete, upload over symlink) from passing.
    const v1Refs = allCmds.filter((c) => c.includes('relay-0.1.0+v1hash'))
    for (const cmd of v1Refs) {
      const isReadOnlyProbe =
        /^\s*ls\b/.test(cmd) ||
        /\btest -d\b/.test(cmd) ||
        /\btest -f\b/.test(cmd) ||
        /\btest -S\b/.test(cmd) ||
        /\bfor f in .*\.sock\b/.test(cmd)
      expect(isReadOnlyProbe, `unexpected v1 reference: ${cmd}`).toBe(true)
    }
  })
})
