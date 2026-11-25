import { execFileSync, spawnSync } from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppProfile, runProfilesCreate, type RunTool } from './app-profile-create'

const DEFAULT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.stablyai.orca</string>
  <key>CFBundleExecutable</key><string>Orca</string>
  <key>CFBundleName</key><string>Orca</string>
  <key>CFBundleDisplayName</key><string>Orca</string>
  <key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>orca</string></array></dict></array>
  <key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeRole</key><string>Editor</string></dict></array>
  <key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict/></dict>
</dict>
</plist>
`

let dir: string
let app: string
let calls: string[][]

// Real ditto and plutil; codesign and lsregister are recorded.
const run: RunTool = (program, args) => {
  calls.push([program, ...args])
  if (program.endsWith('codesign')) {
    return args[0] === '-d' ? '<plist><dict/></plist>' : ''
  }
  if (program.endsWith('lsregister')) {
    return ''
  }
  return execFileSync(program, args, { encoding: 'utf8' })
}

function file(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, { mode: 0o755 })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-profile-create-'))
  app = join(dir, 'Orca.app')
  const contents = join(app, 'Contents')
  file(join(contents, 'Info.plist'), DEFAULT_PLIST)
  file(join(contents, 'PkgInfo'), 'APPL????')
  file(join(contents, 'MacOS', 'Orca'), 'main')
  file(join(contents, 'MacOS', 'orca-notification-status'), 'default variant')
  file(join(contents, 'MacOS', 'orca-keyboard-layout'), 'layout')
  file(join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'x'), 'fw')
  file(
    join(contents, 'Frameworks', 'Orca Helper (Renderer).app', 'Contents', 'MacOS', 'h'),
    'helper'
  )
  file(join(contents, 'Frameworks', 'Squirrel.framework', 'Versions', 'A', 'y'), 'squirrel')
  file(join(contents, 'Resources', 'app.asar'), 'asar')
  file(
    join(contents, 'Resources', 'profile-template', 'orca-notification-status'),
    'profile variant'
  )
  calls = []
  vi.stubEnv('HOME', dir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const env = (): NodeJS.ProcessEnv => ({
  ORCA_PROFILES_ROOT: join(dir, 'data'),
  ORCA_PROFILES_APPS_DIR: join(dir, 'apps')
})

function plistValue(path: string, key: string): string | null {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

describe.skipIf(process.platform !== 'darwin')('createAppProfile', () => {
  it('builds the thin bundle: copied executables and helpers, linked frameworks and resources', () => {
    const entry = createAppProfile({
      name: 'Orca - Work',
      defaultAppPath: app,
      env: env(),
      run,
      now: () => 1,
      pinRoot: true
    })
    const contents = join(entry.appPath, 'Contents')
    expect(entry).toEqual({
      id: 'orca-work',
      name: 'Orca - Work',
      bundleId: 'com.stablyai.orca.profile.orca-work',
      appPath: join(dir, 'apps', 'Orca - Work.app'),
      userDataPath: join(dir, 'data', 'orca-work'),
      createdAt: 1
    })
    const isLink = (path: string): boolean => lstatSync(path).isSymbolicLink()
    expect(isLink(join(contents, 'MacOS', 'Orca'))).toBe(false)
    expect(lstatSync(join(contents, 'MacOS', 'Orca')).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(contents, 'MacOS', 'orca-notification-status'), 'utf8')).toBe(
      'profile variant'
    )
    expect(isLink(join(contents, 'Frameworks', 'Orca Helper (Renderer).app'))).toBe(false)
    // The Electron framework is a clone: helpers crash when it is a link.
    expect(isLink(join(contents, 'Frameworks', 'Electron Framework.framework'))).toBe(false)
    expect(
      readFileSync(
        join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'x'),
        'utf8'
      )
    ).toBe('fw')
    expect(readlinkSync(join(contents, 'Frameworks', 'Squirrel.framework'))).toBe(
      join(app, 'Contents', 'Frameworks', 'Squirrel.framework')
    )
    expect(isLink(join(contents, 'Resources'))).toBe(false)
    expect(readlinkSync(join(contents, 'Resources', 'app.asar'))).toBe(
      join(app, 'Contents', 'Resources', 'app.asar')
    )

    const plist = join(contents, 'Info.plist')
    expect(plistValue(plist, 'CFBundleIdentifier')).toBe(entry.bundleId)
    expect(plistValue(plist, 'CFBundleDisplayName')).toBe('Orca - Work')
    expect(plistValue(plist, 'CFBundleName')).toBe('Orca')
    expect(plistValue(plist, 'OrcaAppProfileId')).toBe('orca-work')
    expect(plistValue(plist, 'OrcaAppProfilesRoot')).toBe(join(dir, 'data'))
    expect(plistValue(plist, 'CFBundleURLTypes')).toBeNull()
    expect(plistValue(plist, 'ElectronAsarIntegrity')).toBeNull()
    expect(plistValue(plist, 'CFBundleDocumentTypes.0.CFBundleTypeRole')).toBe('Editor')

    // Small executables first, then the bundle; ad hoc, no --deep, no hardened runtime.
    const signs = calls.filter((call) => call[0].endsWith('codesign') && call[1] === '--force')
    expect(signs.map((call) => call.at(-1))).toEqual([
      expect.stringMatching(/MacOS\/orca-keyboard-layout$/),
      expect.stringMatching(/MacOS\/orca-notification-status$/),
      expect.stringMatching(/Orca - Work\.app$/)
    ])
    for (const call of signs) {
      expect(call).toEqual(expect.arrayContaining(['-s', '-', '-i', entry.bundleId]))
      expect(call).not.toContain('--deep')
      expect(call).not.toContain('--options')
    }
    expect(calls.at(-1)).toEqual([expect.stringMatching(/lsregister$/), '-f', entry.appPath])

    expect(
      JSON.parse(readFileSync(join(entry.userDataPath, 'orca-app-profile.json'), 'utf8'))
    ).toEqual({
      id: 'orca-work'
    })
    const registry = JSON.parse(readFileSync(join(dir, 'data', 'profiles.json'), 'utf8'))
    expect(registry).toMatchObject({ version: 1, defaultAppPath: app, profiles: [entry] })
  })

  it('refuses a name that leaves the apps folder, and the reserved id default', () => {
    const before = readdirSync(dir)
    expect(() =>
      createAppProfile({ name: '../../x', defaultAppPath: app, env: env(), run })
    ).toThrow('Not a profile name')
    expect(readdirSync(dir)).toEqual(before)
    expect(() =>
      createAppProfile({ name: 'Default', defaultAppPath: app, env: env(), run })
    ).toThrow('Not a profile name')
    expect(existsSync(join(dir, 'apps', 'Default.app'))).toBe(false)
  })

  it('refuses a taken id', () => {
    createAppProfile({ name: 'Work', defaultAppPath: app, env: env(), run })
    expect(() => createAppProfile({ name: 'work', defaultAppPath: app, env: env(), run })).toThrow(
      'The profile "work" exists.'
    )
  })
})

describe.skipIf(process.platform !== 'darwin')('createAppProfile refusals and failures', () => {
  it('maps `_` to `-`, so `a_b` and `a-b` cannot share a bundle id', () => {
    expect(createAppProfile({ name: 'a_b', defaultAppPath: app, env: env(), run }).bundleId).toBe(
      'com.stablyai.orca.profile.a-b'
    )
    expect(() => createAppProfile({ name: 'a-b', defaultAppPath: app, env: env(), run })).toThrow(
      'The profile "a-b" exists.'
    )
  })

  it('keeps a profiles.json that it cannot read', () => {
    const registry = join(dir, 'data', 'profiles.json')
    file(registry, '{"version": 1, "profiles": [')
    expect(() => createAppProfile({ name: 'Work', defaultAppPath: app, env: env(), run })).toThrow(
      `${registry} is not a profile list.`
    )
    expect(readFileSync(registry, 'utf8')).toBe('{"version": 1, "profiles": [')
    expect(existsSync(join(dir, 'apps', 'Work.app'))).toBe(false)
  })

  it('writes the marker before the app is in place', () => {
    const checking: RunTool = (program, args) => {
      if (program.endsWith('lsregister')) {
        expect(existsSync(join(dir, 'data', 'work', 'orca-app-profile.json'))).toBe(true)
      }
      return run(program, args)
    }
    createAppProfile({ name: 'Work', defaultAppPath: app, env: env(), run: checking })
    expect(calls.some((call) => call[0].endsWith('lsregister'))).toBe(true)
  })

  it('removes the app when registration fails, so a retry works; the marker stays', () => {
    const failing: RunTool = (program, args) => {
      if (program.endsWith('lsregister')) {
        throw new Error('lsregister failed')
      }
      return run(program, args)
    }
    expect(() =>
      createAppProfile({ name: 'Work', defaultAppPath: app, env: env(), run: failing })
    ).toThrow('lsregister failed')
    expect(existsSync(join(dir, 'apps', 'Work.app'))).toBe(false)
    expect(existsSync(join(dir, 'data', 'work', 'orca-app-profile.json'))).toBe(true)
    expect(createAppProfile({ name: 'Work', defaultAppPath: app, env: env(), run }).id).toBe('work')
  })
})

describe.skipIf(process.platform !== 'darwin')('the profiles.json lock', () => {
  const lock = (): string => join(dir, 'data', 'profiles.json.lock')
  // macOS O_EXLOCK, as createAppProfile takes it.
  const lockFlags = constants.O_RDWR | constants.O_CREAT | 0x20 | constants.O_NONBLOCK

  it('ignores a lock file that a writer which is gone left', () => {
    mkdirSync(join(dir, 'data'), { recursive: true })
    for (const [name, content] of [
      ['Work', String(spawnSync('/usr/bin/true').pid)],
      ['Home', '']
    ]) {
      writeFileSync(lock(), content)
      expect(createAppProfile({ name, defaultAppPath: app, env: env(), run }).name).toBe(name)
      // Another writer may wait on the file, so it stays.
      expect(existsSync(lock())).toBe(true)
    }
  })

  it('refuses while another writer holds the lock', () => {
    mkdirSync(join(dir, 'data'), { recursive: true })
    const held = openSync(lock(), lockFlags)
    try {
      expect(() =>
        createAppProfile({ name: 'Work', defaultAppPath: app, env: env(), run })
      ).toThrow('Another process changes the profiles now')
    } finally {
      closeSync(held)
    }
    expect(createAppProfile({ name: 'Work', defaultAppPath: app, env: env(), run }).id).toBe('work')
    expect(existsSync(lock())).toBe(true)
  })
})

describe.skipIf(process.platform !== 'darwin')('createAppProfile from a profile app', () => {
  it('links to the default app and keeps an inherited root out of Info.plist', () => {
    const work = createAppProfile({ name: 'Work', defaultAppPath: app, env: env(), run })
    // A profile's own `orca` passes the profile app as the running app.
    const home = createAppProfile({ name: 'Home', defaultAppPath: work.appPath, env: env(), run })
    expect(home.bundleId).toBe('com.stablyai.orca.profile.home')
    expect(readlinkSync(join(home.appPath, 'Contents', 'Resources', 'app.asar'))).toBe(
      join(realpathSync(app), 'Contents', 'Resources', 'app.asar')
    )
    for (const entry of [work, home]) {
      const plist = join(entry.appPath, 'Contents', 'Info.plist')
      expect(plistValue(plist, 'OrcaAppProfilesRoot')).toBeNull()
    }
  })
})

describe('orca profiles create --help', () => {
  it('prints the usage and makes no profile', () => {
    vi.stubEnv('ORCA_PROFILES_ROOT', join(dir, 'data'))
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    for (const flag of ['--help', '-h']) {
      runProfilesCreate([flag])
    }
    expect(out.mock.calls).toEqual([
      ['Usage: orca profiles create <name>\n'],
      ['Usage: orca profiles create <name>\n']
    ])
    out.mockRestore()
    expect(existsSync(join(dir, 'data'))).toBe(false)
    expect(() => runProfilesCreate(['--name'])).toThrow('Usage: orca profiles create <name>')
  })
})
