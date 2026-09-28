import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import { prepareSmokeKeychain } from './runtime-serve-smoke-keychain.mjs'

export function resolveRuntimeServeSmokeLaunch(projectDir, userDataDir, port) {
  const serveEntry = join(projectDir, 'out', 'main', 'index.js')
  const ORCAD_ENTRY = join(projectDir, 'out', 'orcad', 'orcad.js')
  // Why a flag and not just an env var: package scripts have to set this on Windows too,
  // and `FOO=bar cmd` is not portable there.
  const packageArg = process.argv.find((arg) => arg.startsWith('--packaged-app-dir='))
  if (packageArg) {
    const app = resolve(packageArg.slice('--packaged-app-dir='.length))
    const resources = join(
      app,
      ...(app.endsWith('.app') ? ['Contents', 'Resources'] : ['resources'])
    )
    const home = join(userDataDir, 'home')
    for (const directory of [
      home,
      join(home, 'AppData', 'Roaming'),
      join(home, 'AppData', 'Local')
    ]) {
      mkdirSync(directory, { recursive: true })
    }
    return {
      label: `packaged CLI (${app})`,
      verifyFinalExport: true,
      dispose: prepareSmokeKeychain(home),
      command: join(
        resources,
        'bin',
        process.platform === 'win32' ? 'orca.exe' : app.endsWith('.app') ? 'orca' : 'orca-ide'
      ),
      args: ['serve', '--json', '--port', String(port)],
      ownerLoss: process.platform === 'win32',
      env: {
        ORCA_APP_EXECUTABLE: undefined,
        ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT: undefined,
        ELECTRON_RUN_AS_NODE: undefined,
        NODE_OPTIONS: undefined,
        NODE_PATH: undefined,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
        ORCA_E2E_HEADLESS: '1',
        ORCA_E2E_USER_DATA_DIR: userDataDir,
        ORCA_E2E_HOME_DIR: home,
        ORCA_USER_DATA_PATH: userDataDir,
        ORCA_BACKGROUND_LAUNCH: '1'
      }
    }
  }
  const flagIndex = process.argv.indexOf('--target')
  const target =
    flagIndex !== -1 ? process.argv[flagIndex + 1] : (process.env.ORCA_SMOKE_TARGET ?? 'electron')
  if (target === 'orcad') {
    return {
      label: `orcad (${ORCAD_ENTRY})`,
      lockPath: join(userDataDir, 'orcad.lock'),
      command: join(projectDir, 'out', 'orcad', orcadBunRuntimeFilename(process.platform)),
      args: [ORCAD_ENTRY, '--port', String(port), '--json'],
      env: { ORCA_USER_DATA: userDataDir }
    }
  }
  if (target !== 'electron') {
    throw new Error(
      `--target (or ORCA_SMOKE_TARGET) must be 'electron' or 'orcad', got '${target}'`
    )
  }
  const serveArgs = [
    serveEntry,
    '--serve',
    '--serve-port',
    String(port),
    '--serve-json',
    `--user-data-dir=${userDataDir}`
  ]
  const override = process.env.ORCA_SMOKE_ELECTRON
  return {
    label: `electron (${serveEntry})`,
    command: override ?? 'npx',
    args: override ? serveArgs : ['electron', ...serveArgs],
    env: {}
  }
}

export function verifyRuntimeServeSmokeFinalExport(userDataDir, worktreeId) {
  const index = JSON.parse(readFileSync(join(userDataDir, 'orca-profile-index.json'), 'utf8'))
  const data = JSON.parse(
    readFileSync(join(userDataDir, 'profiles', index.activeProfileId, 'orca-data.json'), 'utf8')
  )
  const meta = data.worktreeMeta?.[worktreeId]
  const repoId = worktreeId.split('::')[0]
  if (
    !meta?.instanceId ||
    !worktreeId.endsWith(`::workspace:${meta.instanceId}`) ||
    !data.repos?.some((repo) => repo.id === repoId && repo.kind === 'folder')
  ) {
    throw new Error('Final shutdown export omitted the newly created folder workspace')
  }
}

// Read only the PID: runtime metadata also contains authentication credentials.
export function readRuntimeServeSmokePid(userDataDir) {
  try {
    const { pid } = JSON.parse(readFileSync(join(userDataDir, 'orca-runtime.json'), 'utf8'))
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function runtimeServeSmokeProcessState(pid) {
  if (pid === null) {
    return 'unknown'
  }
  try {
    process.kill(pid, 0)
    return 'live'
  } catch (error) {
    return error.code === 'ESRCH' ? 'exited' : 'unverifiable'
  }
}
