import { describe, expect, it } from 'vitest'
import { buildDaemonForkArgs } from './daemon-fork-args'
import { parseArgs } from './daemon-entry'

const BASE = {
  socketPath: '/tmp/orca-pkgb-pass/daemon/daemon-v36.sock',
  tokenPath: '/tmp/orca-pkgb-pass/daemon/daemon-v36.token',
  pidPath: '/tmp/orca-pkgb-pass/daemon/daemon-v36.pid',
  launchNonce: 'nonce-1',
  entryPath: '/app/out/main/daemon-entry.js',
  appVersion: '1.4.178-rc.2',
  spawnerExecPath: '/app/Electron',
  macosLoginSessionWatch: false,
  logArgs: ['--log-file', '/tmp/orca-pkgb-pass/logs/daemon.log'],
  ownerPid: 73836
}

/** These drive the SAME builder production forks with, and the SAME parser the
 *  daemon entrypoint runs — a helper nobody calls proves nothing. */
describe('what a daemon is told about its owner', () => {
  it('NEGATIVE CONTROL: a disposable state root pins the owner it must die with', () => {
    // Nineteen candidate daemons outlived their runtimes because nothing in
    // their argv named an owner to watch.
    const args = buildDaemonForkArgs({ ...BASE, disposableProfile: true })
    expect(args).toContain('--retire-with-owner')
    expect(args[args.indexOf('--retire-with-owner') + 1]).toBe('73836')
  })

  it('leaves the packaged profile warm: no owner watch, daemon survives quit', () => {
    expect(buildDaemonForkArgs({ ...BASE, disposableProfile: false })).not.toContain(
      '--retire-with-owner'
    )
  })

  it('round-trips through the real daemon entrypoint parser', () => {
    const parsed = parseArgs(buildDaemonForkArgs({ ...BASE, disposableProfile: true }))
    expect(parsed.retireWithOwnerPid).toBe(73836)
    expect(parsed.socketPath).toBe(BASE.socketPath)
    expect(parsed.pidPath).toBe(BASE.pidPath)
    // The warm profile parses to no watch at all, not to a zero it might act on.
    expect(
      parseArgs(buildDaemonForkArgs({ ...BASE, disposableProfile: false })).retireWithOwnerPid
    ).toBeUndefined()
  })

  it('refuses an owner pid it could act on wrongly rather than retiring instantly', () => {
    // pid 0 and pid 1 are not owners; probing them would retire on the first
    // tick or never, and both are worse than no watch.
    for (const bad of ['0', '1', '-5', 'not-a-pid']) {
      expect(
        parseArgs([...buildDaemonForkArgs(BASE), '--retire-with-owner', bad]).retireWithOwnerPid
      ).toBeUndefined()
    }
  })

  it('still carries the macOS login-session watch alongside the owner watch', () => {
    const args = buildDaemonForkArgs({
      ...BASE,
      macosLoginSessionWatch: true,
      disposableProfile: true
    })
    expect(args).toContain('--login-session-watch')
    expect(args).toContain('--retire-with-owner')
    const parsed = parseArgs(args)
    expect(parsed.loginSessionWatch).toBe(true)
    expect(parsed.retireWithOwnerPid).toBe(73836)
  })
})
