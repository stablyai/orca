// `orca profiles create <name>`: makes the thin profile app. A hidden command for now.
import { runProcessSync } from '@orca/process-host'
import {
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  APP_PROFILE_PLIST_ID_KEY,
  APP_PROFILE_PLIST_ROOT_KEY,
  APP_PROFILES_REGISTRY,
  appProfilesAppsDir,
  appProfilesRoot,
  ensureAppProfileMarker,
  readAppProfileRegistry,
  readPlistString,
  type AppProfileEntry,
  type AppProfileRegistry
} from '../../shared/app-profiles/app-profile-paths'
import { getMacAppBundlePath } from '../runtime/serve/updates/mac-app-update-bundle'
import { getPackagedElectronExecutable } from '../runtime/app-launch/packaged-cli-interpreter'
import { RuntimeClientError } from '../runtime/connection/types'

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const NOTIFICATION_HELPER = 'orca-notification-status'
const ELECTRON_FRAMEWORK = 'Electron Framework.framework'

/** Runs a tool and returns its stdout; throws when it fails. */
export type RunTool = (program: string, args: string[]) => string

const runTool: RunTool = (program, args) => {
  const result = runProcessSync({ program, args, timeoutMs: 120_000 })
  if (result.code !== 0) {
    throw new Error(`${program} failed: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  return result.stdout
}

export type CreateAppProfileOptions = {
  name: string
  defaultAppPath: string
  /** Test runs only: write the profiles root into Info.plist, so a Dock launch finds a test root. */
  pinRoot?: boolean
  env?: NodeJS.ProcessEnv
  home?: string
  run?: RunTool
  now?: () => number
}

export function appProfileIdFromName(name: string): string {
  return (
    name
      .toLowerCase()
      // A bundle id has no `_`, so `a_b` and `a-b` are one id.
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  )
}

/** Builds and signs the profile app, writes its marker and adds it to profiles.json. */
export function createAppProfile(options: CreateAppProfileOptions): AppProfileEntry {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const run = options.run ?? runTool
  const name = options.name.trim()
  const id = appProfileIdFromName(name)
  // `default` names the default app in `orca --profile default`.
  if (!name || !id || id === 'default' || name.includes('/')) {
    throw new RuntimeClientError('invalid_argument', `Not a profile name: "${options.name}"`)
  }
  const root = resolve(appProfilesRoot(env, home))
  const appsDir = resolve(appProfilesAppsDir(env, home))
  const defaultApp = defaultAppOf(resolve(options.defaultAppPath))
  const source = join(defaultApp, 'Contents')
  mkdirSync(root, { recursive: true })
  mkdirSync(appsDir, { recursive: true })

  return withRegistryLock(root, () => {
    const registryPath = join(root, APP_PROFILES_REGISTRY)
    const existing = readAppProfileRegistry(root)
    // A list that does not read must stay: a new list would drop its profiles.
    if (!existing && existsSync(registryPath)) {
      throw new RuntimeClientError('invalid_argument', `${registryPath} is not a profile list.`)
    }
    const registry: AppProfileRegistry = existing ?? {
      version: 1,
      defaultAppPath: defaultApp,
      profiles: []
    }
    if (registry.profiles.some((profile) => profile.id === id)) {
      throw new RuntimeClientError('invalid_argument', `The profile "${id}" exists.`)
    }
    const appPath = join(appsDir, `${name}.app`)
    if (existsSync(appPath)) {
      throw new RuntimeClientError('invalid_argument', `${appPath} exists.`)
    }
    const template = join(source, 'Resources', 'profile-template', NOTIFICATION_HELPER)
    if (!existsSync(template)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `${defaultApp} has no profile notification helper. It is too old for profiles.`
      )
    }

    // Build in a temporary folder and move the bundle in place when it is complete.
    const staging = mkdtempSync(join(appsDir, `.${id}.staging-`))
    try {
      const bundle = join(staging, `${name}.app`)
      const contents = join(bundle, 'Contents')
      for (const folder of ['MacOS', 'Frameworks', 'Resources']) {
        mkdirSync(join(contents, folder), { recursive: true })
      }
      const plistPath = join(contents, 'Info.plist')
      run('/usr/bin/ditto', [join(source, 'Info.plist'), plistPath])
      run('/usr/bin/plutil', ['-convert', 'xml1', plistPath])
      if (existsSync(join(source, 'PkgInfo'))) {
        run('/usr/bin/ditto', [join(source, 'PkgInfo'), join(contents, 'PkgInfo')])
      }
      const defaultPlist = readFileSync(plistPath, 'utf8')
      const defaultAppId = readPlistString(defaultPlist, 'CFBundleIdentifier')
      const executable = readPlistString(defaultPlist, 'CFBundleExecutable')
      if (!defaultAppId || !executable) {
        throw new RuntimeClientError('invalid_argument', `${defaultApp} has no bundle id.`)
      }
      const bundleId = `${defaultAppId}.profile.${id}`

      // No executable is a link: codesign --force could follow it and sign the default app's file.
      const helpers: string[] = []
      for (const entry of readdirSync(join(source, 'MacOS'))) {
        const from = entry === NOTIFICATION_HELPER ? template : join(source, 'MacOS', entry)
        run('/usr/bin/ditto', [from, join(contents, 'MacOS', entry)])
        if (entry !== executable) {
          helpers.push(join(contents, 'MacOS', entry))
        }
      }
      // Electron helper apps are copies, so they find the profile as their main bundle. Helpers
      // crash at start when the Electron framework is a link, so it is an APFS clone.
      for (const entry of readdirSync(join(source, 'Frameworks'))) {
        const from = join(source, 'Frameworks', entry)
        const to = join(contents, 'Frameworks', entry)
        if (entry.endsWith('.app')) {
          run('/usr/bin/ditto', [from, to])
        } else if (entry === ELECTRON_FRAMEWORK) {
          run('/bin/cp', ['-cR', from, to])
        } else {
          symlinkSync(from, to)
        }
      }
      for (const entry of readdirSync(join(source, 'Resources'))) {
        symlinkSync(join(source, 'Resources', entry), join(contents, 'Resources', entry))
      }

      const plutil = (...args: string[]): void => {
        run('/usr/bin/plutil', [...args, plistPath])
      }
      plutil('-replace', 'CFBundleIdentifier', '-string', bundleId)
      plutil('-replace', 'CFBundleDisplayName', '-string', name)
      plutil('-replace', APP_PROFILE_PLIST_ID_KEY, '-string', id)
      if (options.pinRoot) {
        plutil('-replace', APP_PROFILE_PLIST_ROOT_KEY, '-string', root)
      }
      // A profile does not claim orca: links. The asar integrity fuse is off.
      for (const key of ['CFBundleURLTypes', 'ElectronAsarIntegrity']) {
        if (readPlistKeyExists(readFileSync(plistPath, 'utf8'), key)) {
          plutil('-remove', key)
        }
      }

      // Ad hoc, no --deep (the helper apps keep their signatures), no hardened runtime
      // (library validation would refuse the default app's frameworks).
      const entitlements = join(staging, 'entitlements.plist')
      writeFileSync(
        entitlements,
        run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', defaultApp])
      )
      for (const helper of helpers) {
        run('/usr/bin/codesign', ['--force', '-s', '-', '-i', bundleId, helper])
      }
      run('/usr/bin/codesign', [
        '--force',
        '-s',
        '-',
        '-i',
        bundleId,
        '--entitlements',
        entitlements,
        bundle
      ])
      // The marker comes first: a launchable app always finds its profile. A later failure
      // removes the app, so a retry with the same name works.
      const userDataPath = join(root, id)
      ensureAppProfileMarker(userDataPath, id)
      const entry: AppProfileEntry = {
        id,
        name,
        bundleId,
        appPath,
        userDataPath,
        createdAt: (options.now ?? Date.now)()
      }
      renameSync(bundle, appPath)
      try {
        run(LSREGISTER, ['-f', appPath])
        writeRegistry(root, { ...registry, profiles: [...registry.profiles, entry] })
      } catch (error) {
        rmSync(appPath, { recursive: true, force: true })
        throw error
      }
      return entry
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  })
}

/** A profile's `orca` runs in the profile app; its app.asar link points into the default app. */
function defaultAppOf(appPath: string): string {
  const plist = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')
  if (readPlistString(plist, APP_PROFILE_PLIST_ID_KEY) === null) {
    return appPath
  }
  return resolve(realpathSync(join(appPath, 'Contents', 'Resources', 'app.asar')), '..', '..', '..')
}

function readPlistKeyExists(xml: string, key: string): boolean {
  return xml.includes(`<key>${key}</key>`)
}

function writeRegistry(root: string, registry: AppProfileRegistry): void {
  const path = join(root, APP_PROFILES_REGISTRY)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`)
  renameSync(temporary, path)
}

// macOS O_EXLOCK: the kernel holds the lock while the file is open and drops it when the
// process ends, so a writer that crashed leaves no lock. The file itself stays.
const REGISTRY_LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | 0x20 | constants.O_NONBLOCK

function withRegistryLock<T>(root: string, body: () => T): T {
  const lock = join(root, `${APP_PROFILES_REGISTRY}.lock`)
  let fd: number
  try {
    fd = openSync(lock, REGISTRY_LOCK_FLAGS, 0o600)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EAGAIN') {
      throw new RuntimeClientError('invalid_argument', 'Another process changes the profiles now.')
    }
    throw error
  }
  try {
    return body()
  } finally {
    // Never remove the file: another writer may wait on it.
    closeSync(fd)
  }
}

const CREATE_USAGE = 'Usage: orca profiles create <name>'

/** The CLI entry: `orca profiles create <name>`. */
export function runProfilesCreate(argv: string[]): void {
  // --pin-root: test runs with ORCA_PROFILES_ROOT; an inherited root must not stick in a bundle.
  const pinRoot = argv.includes('--pin-root')
  const rest = argv.filter((arg) => arg !== '--pin-root')
  if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) {
    process.stdout.write(`${CREATE_USAGE}\n`)
    return
  }
  // A name never starts with `-`: that is an option.
  if (rest.length !== 1 || rest[0].startsWith('-')) {
    throw new RuntimeClientError('invalid_argument', CREATE_USAGE)
  }
  if (process.platform !== 'darwin') {
    throw new RuntimeClientError('unsupported_platform', 'Profiles are only on macOS.')
  }
  // On the bundled Node, the launcher names the app executable.
  const executable = getPackagedElectronExecutable() ?? process.execPath
  const defaultAppPath = getMacAppBundlePath(executable)
  if (!defaultAppPath) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Run this command with the orca CLI of an Orca app.'
    )
  }
  const entry = createAppProfile({ name: rest[0], defaultAppPath, pinRoot })
  process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`)
}
