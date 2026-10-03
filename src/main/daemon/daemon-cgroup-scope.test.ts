import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildLegacyScopeMigrationCommand,
  buildDurableDaemonScopeCommand,
  daemonScopeUnitName,
  detectOwnCgroupScopeUnit,
  isDurableDaemonScopeSupported,
  migrateLegacyDaemonScope,
  readLegacyDaemonScopeProcesses
} from './daemon-cgroup-scope'

// The suite names its own user, so no fixture needs the host's passwd database (a UID without an
// entry is common in containers). `null` stands for "this UID has no passwd entry".
const SUITE_USER = 'orca-test'
const fakeUser = vi.hoisted(() => ({ name: null as string | null }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    userInfo: () => {
      if (fakeUser.name === null) {
        throw new Error('ENOENT: no passwd entry')
      }
      return { uid: -1, gid: -1, username: fakeUser.name, homedir: actual.tmpdir(), shell: null }
    }
  }
})

beforeEach(() => {
  fakeUser.name = SUITE_USER
})

describe('daemonScopeUnitName', () => {
  it('prefixes the launch nonce so the unit is traceable back to a launch', () => {
    expect(daemonScopeUnitName('c0ffee12-3456-7890-abcd-ef0123456789')).toBe(
      'orca-daemon-c0ffee12-3456-7890-abcd-ef0123456789.scope'
    )
  })

  it('sanitizes characters systemd unit names reject', () => {
    expect(daemonScopeUnitName('weird nonce/with:stuff')).toBe(
      'orca-daemon-weird-nonce-with:stuff.scope'
    )
  })
})

// Real, connectable AF_UNIX sockets rather than plain files at "bus" — the fix under test
// distinguishes a genuinely reachable bus from a stale file/directory left at that path, so a
// fixture that only `existsSync`-passes would not exercise it.
const fakeBusServers: Server[] = []
const fakeBusDirs: string[] = []
const fakeSystemdBootDirs: string[] = []
const fakeUserManagerDirs: string[] = []

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

// logind's record of `loginctl enable-linger <user>`: one file per lingering user, named by
// systemd's cescape() of the user name (a plain ASCII name is its own record name).
function fakeLingerDir({
  lingering,
  record = SUITE_USER
}: {
  lingering: boolean
  record?: string
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'systemd-linger-'))
  if (lingering) {
    writeFileSync(join(dir, record), '')
  }
  fakeUserManagerDirs.push(dir)
  return dir
}

// Stands in for the launcher's own /proc/self/cgroup.
function fakeOwnCgroup(cgroupPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'own-cgroup-'))
  const path = join(dir, 'cgroup')
  writeFileSync(path, `0::${cgroupPath}\n`)
  fakeUserManagerDirs.push(dir)
  return path
}

const SYSTEM_SERVICE_CGROUP = '/system.slice/orca-serve.service'

afterEach(() => {
  vi.restoreAllMocks()
  for (const server of fakeBusServers.splice(0)) {
    server.close()
  }
  for (const dir of fakeBusDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const dir of fakeSystemdBootDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const dir of fakeUserManagerDirs.splice(0)) {
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
        () => ({ code: 0, timedOut: false }),
        fakeLingerDir({ lingering: true }),
        fakeOwnCgroup(SYSTEM_SERVICE_CGROUP)
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
        () => ({ code: 0, timedOut: false }),
        fakeLingerDir({ lingering: true }),
        fakeOwnCgroup(SYSTEM_SERVICE_CGROUP)
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
        () => ({ code: 0, timedOut: false }),
        fakeLingerDir({ lingering: true }),
        fakeOwnCgroup(SYSTEM_SERVICE_CGROUP)
      )
    ).toBe(true)
  })

  it('is false when the user manager stops at the last logout: no lingering, launched outside it', () => {
    // A system unit with User=<account> while that account happens to have an SSH login open:
    // the bus exists only for as long as that login does.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const perUidDir = fakeRuntimeDirWithBus()
    const bootPath = fakeSystemdBootPath()
    const notLingering = fakeLingerDir({ lingering: false })
    for (const ownCgroup of [
      SYSTEM_SERVICE_CGROUP,
      `/user.slice/user-${process.getuid?.() ?? 1000}.slice/session-4.scope`
    ]) {
      expect(
        isDurableDaemonScopeSupported(
          { XDG_RUNTIME_DIR: perUidDir },
          'linux',
          perUidDir,
          bootPath,
          () => ({ code: 0, timedOut: false }),
          notLingering,
          fakeOwnCgroup(ownCgroup)
        )
      ).toBe(false)
    }
  })

  it('is true for a service outside the user manager when lingering keeps that manager alive', () => {
    const perUidDir = fakeRuntimeDirWithBus()
    expect(
      isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: perUidDir },
        'linux',
        perUidDir,
        fakeSystemdBootPath(),
        () => ({ code: 0, timedOut: false }),
        fakeLingerDir({ lingering: true }),
        fakeOwnCgroup(SYSTEM_SERVICE_CGROUP)
      )
    ).toBe(true)
  })

  it.skipIf(typeof process.getuid !== 'function')(
    "is true without lingering when the launcher already runs under this user's manager",
    () => {
      // A `systemctl --user` unit (or an `app-*.scope`) under user@<uid>.service: the daemon's
      // scope can lose that manager no sooner than its launcher does. Another user's manager does
      // not count.
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const uid = process.getuid!()
      const perUidDir = fakeRuntimeDirWithBus()
      const bootPath = fakeSystemdBootPath()
      const notLingering = fakeLingerDir({ lingering: false })
      const probe = (ownCgroup: string): boolean =>
        isDurableDaemonScopeSupported(
          { XDG_RUNTIME_DIR: perUidDir },
          'linux',
          perUidDir,
          bootPath,
          () => ({ code: 0, timedOut: false }),
          notLingering,
          fakeOwnCgroup(ownCgroup)
        )
      expect(
        probe(`/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/orca-serve.service`)
      ).toBe(true)
      expect(
        probe(`/user.slice/user-${uid + 1}.slice/user@${uid + 1}.service/app.slice/x.scope`)
      ).toBe(false)
    }
  )

  it('names loginctl enable-linger once per process when lingering is what blocks the scope', async () => {
    vi.resetModules()
    const fresh = await import('./daemon-cgroup-scope')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const perUidDir = fakeRuntimeDirWithBus()
    const bootPath = fakeSystemdBootPath()
    const ownCgroup = fakeOwnCgroup(SYSTEM_SERVICE_CGROUP)
    const probe = (lingerDir: string): boolean =>
      fresh.isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: perUidDir },
        'linux',
        perUidDir,
        bootPath,
        () => ({ code: 0, timedOut: false }),
        lingerDir,
        ownCgroup
      )

    expect(probe(fakeLingerDir({ lingering: true }))).toBe(true)
    expect(warn).not.toHaveBeenCalled()

    const notLingering = fakeLingerDir({ lingering: false })
    expect(probe(notLingering)).toBe(false)
    expect(probe(notLingering)).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain(`lingering is off for ${SUITE_USER}`)
    expect(message).toContain(`loginctl enable-linger ${SUITE_USER}`)
    expect(message).toContain('docs/reference/headless-linux-server.md')
    expect(message).not.toContain('\n')
  })

  it('does not name enable-linger when an earlier gate already rules the scope out', async () => {
    // macOS, Windows, containers and hosts without a user bus or systemd-run would not get a
    // durable scope from lingering either, so the hint would send the user the wrong way.
    vi.resetModules()
    const fresh = await import('./daemon-cgroup-scope')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const perUidDir = fakeRuntimeDirWithBus()
    const bootPath = fakeSystemdBootPath()
    const notLingering = fakeLingerDir({ lingering: false })
    const ownCgroup = fakeOwnCgroup(SYSTEM_SERVICE_CGROUP)
    const probe = (
      platform: NodeJS.Platform,
      runtimeDir: string,
      systemdBootPath: string,
      code: number
    ): boolean =>
      fresh.isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: runtimeDir },
        platform,
        runtimeDir,
        systemdBootPath,
        () => ({ code, timedOut: false }),
        notLingering,
        ownCgroup
      )

    expect(probe('darwin', perUidDir, bootPath, 0)).toBe(false)
    expect(probe('linux', perUidDir, '/definitely/not/systemd-boot', 0)).toBe(false)
    expect(probe('linux', fakeRuntimeDirWithoutBus(), bootPath, 0)).toBe(false)
    expect(probe('linux', perUidDir, bootPath, 1)).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('fails closed when its own cgroup file cannot be read and lingering is off', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const perUidDir = fakeRuntimeDirWithBus()
    const notLingering = fakeLingerDir({ lingering: false })
    expect(
      isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: perUidDir },
        'linux',
        perUidDir,
        fakeSystemdBootPath(),
        () => ({ code: 0, timedOut: false }),
        notLingering,
        join(notLingering, 'no-such-cgroup-file')
      )
    ).toBe(false)
  })

  // logind names the record by systemd's cescape() of the user name (src/login/logind-dbus.c,
  // src/basic/escape.c), so a raw-name lookup misses every name it escapes.
  for (const [name, record] of [
    ['DOMAIN\\orca', 'DOMAIN\\\\orca'],
    ['josé', 'jos\\303\\251'],
    ["o'brien", "o\\'brien"],
    ['tab\there"\x7f', 'tab\\there\\"\\177']
  ] as const) {
    it(`finds logind's escaped linger record for ${JSON.stringify(name)}, not a raw-name file`, () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      fakeUser.name = name
      const perUidDir = fakeRuntimeDirWithBus()
      const bootPath = fakeSystemdBootPath()
      const ownCgroup = fakeOwnCgroup(SYSTEM_SERVICE_CGROUP)
      const probe = (lingerDir: string): boolean =>
        isDurableDaemonScopeSupported(
          { XDG_RUNTIME_DIR: perUidDir },
          'linux',
          perUidDir,
          bootPath,
          () => ({ code: 0, timedOut: false }),
          lingerDir,
          ownCgroup
        )
      expect(probe(fakeLingerDir({ lingering: true, record }))).toBe(true)
      expect(probe(fakeLingerDir({ lingering: true, record: name }))).toBe(false)
    })
  }

  it('fails closed when this UID has no passwd entry, whoever else is lingering, and says it cannot tell', async () => {
    // Common in containers: without a name there is no linger record to match, so no guess, and
    // no claim that lingering is off.
    vi.resetModules()
    const fresh = await import('./daemon-cgroup-scope')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fakeUser.name = null
    const perUidDir = fakeRuntimeDirWithBus()
    const lingerDir = fakeLingerDir({ lingering: true })
    for (const name of ['root', 'orca', process.env.USER, process.env.LOGNAME]) {
      if (name) {
        writeFileSync(join(lingerDir, name), '')
      }
    }
    expect(
      fresh.isDurableDaemonScopeSupported(
        { XDG_RUNTIME_DIR: perUidDir },
        'linux',
        perUidDir,
        fakeSystemdBootPath(),
        () => ({ code: 0, timedOut: false }),
        lingerDir,
        fakeOwnCgroup(SYSTEM_SERVICE_CGROUP)
      )
    ).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('cannot tell whether lingering is on')
    expect(message).not.toContain('lingering is off')
    expect(message).not.toContain('\n')
  })

  it.skipIf(process.getuid?.() === 0)(
    'fails closed and says it cannot tell when the linger dir cannot be read',
    async () => {
      vi.resetModules()
      const fresh = await import('./daemon-cgroup-scope')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const perUidDir = fakeRuntimeDirWithBus()
      const lingerDir = fakeLingerDir({ lingering: true })
      chmodSync(lingerDir, 0o000)
      try {
        expect(
          fresh.isDurableDaemonScopeSupported(
            { XDG_RUNTIME_DIR: perUidDir },
            'linux',
            perUidDir,
            fakeSystemdBootPath(),
            () => ({ code: 0, timedOut: false }),
            lingerDir,
            fakeOwnCgroup(SYSTEM_SERVICE_CGROUP)
          )
        ).toBe(false)
      } finally {
        chmodSync(lingerDir, 0o700)
      }
      expect(warn).toHaveBeenCalledOnce()
      const message = String(warn.mock.calls[0]?.[0])
      expect(message).toContain(`cannot tell whether lingering is on for ${SUITE_USER}`)
      expect(message).not.toContain('lingering is off')
    }
  )
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
      '--unit=orca-daemon-nonce-1.scope',
      '--property=TimeoutStopSec=5s',
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

  it('recognizes a legacy app-orca scope so an adopted daemon can migrate it', () => {
    const path = writeCgroupFixture('0::/user.slice/user-1000.slice/app-orca-1420296.scope\n')
    expect(detectOwnCgroupScopeUnit('linux', path)).toBe('app-orca-1420296.scope')
  })
})

describe('legacy daemon scope migration', () => {
  it('reads every process in the legacy scope, including detached descendants', () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-scope-migration-'))
    const procDir = join(root, 'proc', '321')
    const cgroupDir = join(root, 'sys', 'user.slice', 'app-orca-1420296.scope')
    mkdirSync(join(procDir), { recursive: true })
    mkdirSync(cgroupDir, { recursive: true })
    writeFileSync(join(procDir, 'cgroup'), '0::/user.slice/app-orca-1420296.scope\n')
    writeFileSync(join(cgroupDir, 'cgroup.procs'), '321\n400\n401\n')
    expect(readLegacyDaemonScopeProcesses(321, join(root, 'proc'), join(root, 'sys'))).toEqual({
      unit: 'app-orca-1420296.scope',
      pids: [321, 400, 401]
    })
    rmSync(root, { recursive: true, force: true })
  })

  it('builds a user-bus StartTransientUnit call containing the whole old scope', () => {
    const command = buildLegacyScopeMigrationCommand(
      'new-nonce',
      [321, 400, 401],
      { XDG_RUNTIME_DIR: '/run/user/1000' },
      null
    )
    expect(command).toEqual({
      command: 'busctl',
      args: [
        '--user',
        'call',
        'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager',
        'StartTransientUnit',
        'ssa(sv)a(sa(sv))',
        'orca-daemon-new-nonce.scope',
        'fail',
        '1',
        'PIDs',
        'au',
        '3',
        '321',
        '400',
        '401',
        '0'
      ],
      env: { XDG_RUNTIME_DIR: '/run/user/1000' }
    })
  })

  it('lets busctl discover the resolved user bus when service hardening disables the inherited address', () => {
    const runtimeDir = fakeRuntimeDirWithBus()
    const command = buildLegacyScopeMigrationCommand(
      'disabled-address',
      [321],
      {
        XDG_RUNTIME_DIR: '/run/orca_serve/factory',
        DBUS_SESSION_BUS_ADDRESS: 'disabled:'
      },
      runtimeDir
    )

    expect(command.env).toEqual({ XDG_RUNTIME_DIR: runtimeDir })
  })

  it('migrates only a proven legacy scope and fails closed when systemd rejects it', () => {
    const runtimeDir = fakeRuntimeDirWithBus()
    const runMigration = vi.fn(() => ({ code: 0, timedOut: false }))
    const migrated = migrateLegacyDaemonScope(
      321,
      'new-nonce',
      { XDG_RUNTIME_DIR: runtimeDir },
      'linux',
      runtimeDir,
      () => ({ unit: 'app-orca-1420296.scope', pids: [321, 400] }),
      fakeSystemdBootPath(),
      () => ({ code: 0, timedOut: false }),
      runMigration,
      fakeLingerDir({ lingering: true }),
      fakeOwnCgroup(SYSTEM_SERVICE_CGROUP)
    )
    expect(migrated).toBe(true)
    expect(runMigration).toHaveBeenCalledOnce()
    expect(
      migrateLegacyDaemonScope(
        321,
        'new-nonce',
        { XDG_RUNTIME_DIR: runtimeDir },
        'linux',
        runtimeDir,
        () => ({ unit: 'app-orca-1420296.scope', pids: [321, 400] }),
        fakeSystemdBootPath(),
        () => ({ code: 0, timedOut: false }),
        () => ({ code: 1, timedOut: false }),
        fakeLingerDir({ lingering: true }),
        fakeOwnCgroup(SYSTEM_SERVICE_CGROUP)
      )
    ).toBe(false)
  })
})
