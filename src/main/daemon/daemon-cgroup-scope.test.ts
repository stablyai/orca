import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDurableDaemonScopeCommand,
  daemonScopeUnitName,
  detectOwnCgroupScopeUnit,
  isDurableDaemonScopeSupported
} from './daemon-cgroup-scope'

describe('daemonScopeUnitName', () => {
  it('prefixes the launch nonce so the unit is traceable back to a launch', () => {
    expect(daemonScopeUnitName('c0ffee12-3456-7890-abcd-ef0123456789')).toBe(
      'orca-daemon-c0ffee12-3456-7890-abcd-ef0123456789'
    )
  })

  it('sanitizes characters systemd unit names reject', () => {
    expect(daemonScopeUnitName('weird nonce/with:stuff')).toBe('orca-daemon-weird-nonce-with:stuff')
  })
})

// Real, connectable AF_UNIX sockets rather than plain files at "bus" — the fix under test
// distinguishes a genuinely reachable bus from a stale file/directory left at that path, so a
// fixture that only `existsSync`-passes would not exercise it.
const fakeBusServers: Server[] = []
const fakeBusDirs: string[] = []
const fakeSystemdBootDirs: string[] = []

function fakeRuntimeDirWithBus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xdg-runtime-with-bus-'))
  const server = createServer()
  server.listen(join(dir, 'bus'))
  fakeBusServers.push(server)
  fakeBusDirs.push(dir)
  return dir
}

function fakeRuntimeDirWithoutBus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xdg-runtime-no-bus-'))
  fakeBusDirs.push(dir)
  return dir
}

// A directory that reliably exists on every dev host, standing in for the real
// `/run/systemd/system` boot marker that only exists on a systemd host.
function fakeSystemdBootPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'systemd-boot-marker-'))
  fakeSystemdBootDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const server of fakeBusServers.splice(0)) {
    server.close()
  }
  for (const dir of fakeBusDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const dir of fakeSystemdBootDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('isDurableDaemonScopeSupported', () => {
  it('is false on non-Linux platforms regardless of environment', () => {
    expect(isDurableDaemonScopeSupported({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'darwin')).toBe(
      false
    )
    expect(isDurableDaemonScopeSupported({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'win32')).toBe(
      false
    )
  })

  it('is false when not booted under systemd, even with a reachable bus and a working binary', () => {
    const perUidDir = fakeRuntimeDirWithBus()
    expect(
      isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: perUidDir },
        'linux',
        perUidDir,
        '/definitely/not/systemd-boot',
        () => ({ code: 0, timedOut: false })
      )
    ).toBe(false)
  })

  it('is false when there is no runtime dir to resolve at all', () => {
    expect(
      isDurableDaemonScopeSupported({}, 'linux', null, fakeSystemdBootPath(), () => ({
        code: 0,
        timedOut: false
      }))
    ).toBe(false)
  })

  it('is false when neither the canonical per-UID path nor the env path has a reachable bus', () => {
    const canonical = fakeRuntimeDirWithoutBus()
    const envDir = fakeRuntimeDirWithoutBus()
    // Neither fixture has a `bus` socket written — the probe must fail closed regardless of
    // which path it looks at first.
    expect(
      isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: envDir },
        'linux',
        canonical,
        fakeSystemdBootPath(),
        () => ({ code: 0, timedOut: false })
      )
    ).toBe(false)
  })

  it('is false when systemd-run --version cannot answer: non-zero exit or a timeout kill', () => {
    const perUidDir = fakeRuntimeDirWithBus()
    const bootPath = fakeSystemdBootPath()
    expect(
      isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: perUidDir },
        'linux',
        perUidDir,
        bootPath,
        () => ({ code: 1, timedOut: false })
      )
    ).toBe(false)
    expect(
      isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: perUidDir },
        'linux',
        perUidDir,
        bootPath,
        () => ({ code: null, timedOut: true })
      )
    ).toBe(false)
  })

  it('is true when the process env XDG_RUNTIME_DIR is a hardened unit override, but the real per-UID dir has a reachable bus (mtl-02 regression)', () => {
    // Simulates orca-serve@factory.service's RuntimeDirectory=factory hardening directive:
    // the process's own XDG_RUNTIME_DIR points at a private scratch dir that is NOT the user
    // session bus location, while the real per-UID runtime dir (injected here in place of the
    // real /run/user/<uid>) has a genuinely reachable bus the whole time.
    const hardenedOverrideDir = fakeRuntimeDirWithoutBus()
    const realPerUidDir = fakeRuntimeDirWithBus()
    expect(
      isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: hardenedOverrideDir },
        'linux',
        realPerUidDir,
        fakeSystemdBootPath(),
        () => ({ code: 0, timedOut: false })
      )
    ).toBe(true)
  })

  it('is true when the caller env XDG_RUNTIME_DIR already points at the correct, reachable per-UID bus', () => {
    const perUidDir = fakeRuntimeDirWithBus()
    expect(
      isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: perUidDir },
        'linux',
        perUidDir,
        fakeSystemdBootPath(),
        () => ({ code: 0, timedOut: false })
      )
    ).toBe(true)
  })

  it('falls back to the process env XDG_RUNTIME_DIR when the canonical per-UID path has no reachable bus', () => {
    // Some hosts legitimately have no /run/user/<uid> at all but do have a working bus
    // wherever their own environment points — the probe must still support that host.
    const canonicalWithoutBus = fakeRuntimeDirWithoutBus()
    const envDirWithBus = fakeRuntimeDirWithBus()
    expect(
      isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: envDirWithBus },
        'linux',
        canonicalWithoutBus,
        fakeSystemdBootPath(),
        () => ({ code: 0, timedOut: false })
      )
    ).toBe(true)
  })
})

describe('buildDurableDaemonScopeCommand', () => {
  it('wraps the daemon command in systemd-run --user --scope with a collected unit', () => {
    const result = buildDurableDaemonScopeCommand(
      '/usr/bin/node',
      ['/opt/orca/daemon-entry.js', '--socket', '/tmp/x.sock'],
      'nonce-1',
      { PATH: '/usr/bin' },
      null
    )
    expect(result.command).toBe('systemd-run')
    expect(result.args).toEqual([
      '--user',
      '--scope',
      '--unit=orca-daemon-nonce-1',
      '--collect',
      '--quiet',
      '--',
      '/usr/bin/node',
      '/opt/orca/daemon-entry.js',
      '--socket',
      '/tmp/x.sock'
    ])
  })

  it('prefers the canonical per-UID runtime dir over a hardened unit-overridden XDG_RUNTIME_DIR (mtl-02 regression)', () => {
    const hardenedOverrideDir = fakeRuntimeDirWithoutBus()
    const realPerUidDir = fakeRuntimeDirWithBus()
    const result = buildDurableDaemonScopeCommand(
      '/usr/bin/node',
      [],
      'n',
      { PATH: '/bin', XDG_RUNTIME_DIR: hardenedOverrideDir },
      realPerUidDir
    )
    // Explicitly the real per-UID dir, not inherited from the spread env's overridden value.
    expect(result.env.XDG_RUNTIME_DIR).toBe(realPerUidDir)
  })

  it('falls back to the caller XDG_RUNTIME_DIR when the canonical per-UID path has no reachable bus', () => {
    const canonicalWithoutBus = fakeRuntimeDirWithoutBus()
    const envDirWithBus = fakeRuntimeDirWithBus()
    const result = buildDurableDaemonScopeCommand(
      '/usr/bin/node',
      [],
      'n',
      { PATH: '/bin', XDG_RUNTIME_DIR: envDirWithBus },
      canonicalWithoutBus
    )
    expect(result.env.XDG_RUNTIME_DIR).toBe(envDirWithBus)
  })

  it('computes the conventional /run/user/<uid> runtime dir when the caller env omits it', () => {
    const perUidDir = fakeRuntimeDirWithBus()
    const result = buildDurableDaemonScopeCommand(
      '/usr/bin/node',
      [],
      'n',
      { PATH: '/bin' },
      perUidDir
    )
    expect(result.env.XDG_RUNTIME_DIR).toBe(perUidDir)
  })
})

describe('detectOwnCgroupScopeUnit', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function writeCgroupFixture(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cgroup-scope-'))
    const path = join(dir, 'cgroup')
    writeFileSync(path, contents)
    tempDirs.push(dir)
    return path
  }

  it('is null on non-Linux platforms without reading any file', () => {
    expect(detectOwnCgroupScopeUnit('darwin', '/nonexistent')).toBeNull()
    expect(detectOwnCgroupScopeUnit('win32', '/nonexistent')).toBeNull()
  })

  it('is null when the cgroup file cannot be read', () => {
    expect(detectOwnCgroupScopeUnit('linux', '/definitely/absent/cgroup')).toBeNull()
  })

  it('parses a v2 unified-hierarchy line naming an orca-daemon scope', () => {
    const path = writeCgroupFixture('0::/user.slice/user-1000.slice/orca-daemon-abc123.scope\n')
    expect(detectOwnCgroupScopeUnit('linux', path)).toBe('orca-daemon-abc123.scope')
  })

  it('parses a v1 systemd-controller line naming an orca-daemon scope', () => {
    const path = writeCgroupFixture(
      '1:name=systemd:/user.slice/user-1000.slice/orca-daemon-def456.scope\n'
    )
    expect(detectOwnCgroupScopeUnit('linux', path)).toBe('orca-daemon-def456.scope')
  })

  it('returns null for a plain service-unit cgroup — the un-isolated case this fix targets', () => {
    const path = writeCgroupFixture('0::/system.slice/orca-serve@factory.service\n')
    expect(detectOwnCgroupScopeUnit('linux', path)).toBeNull()
  })

  it('returns null for a scope unit that is not an orca-daemon one', () => {
    const path = writeCgroupFixture('0::/user.slice/user-1000.slice/some-other-app.scope\n')
    expect(detectOwnCgroupScopeUnit('linux', path)).toBeNull()
  })
})
