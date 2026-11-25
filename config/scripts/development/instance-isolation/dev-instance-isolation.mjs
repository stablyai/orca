import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export const SHARED_DEV_PROFILE_DIR_NAME = 'orca-dev'
// Why the "orca-dev" prefix: CLI/orchestration dev-mode checks match "orca-dev" in ORCA_USER_DATA_PATH.
// Why short: runtime sockets live in userData and macOS caps socket paths at 104 bytes.
export const WORKTREE_DEV_PROFILES_DIR_NAME = 'orca-dev-wt'
export const WORKTREE_PROFILE_MARKER_FILE = 'orca-dev-worktree.json'
export const WORKTREE_PROFILE_NAME_PATTERN = /^[\da-f]{10}$/
export const DEV_PROFILE_MODES = ['shared', 'worktree']

// Why these ranges: clear of Vite's 5173+ (common in projects opened inside dev Orca),
// Chrome's 9222, and Orca's production ports (pairing WebSocket 6768).
export const RENDERER_PORT_RANGE = { base: 15200, spread: 200 }
export const CDP_PORT_RANGE = { base: 9333, spread: 200 }
const PORT_SWEEP = 64

// Values the runner derives per worktree; a dev Orca exports them to every terminal it spawns.
const RUNNER_DERIVED_ENV_KEYS = [
  'ORCA_DEV_REPO_ROOT',
  'ORCA_DEV_INSTANCE_KEY',
  'ORCA_DEV_BRANCH',
  'ORCA_DEV_WORKTREE_NAME',
  'ORCA_DEV_INSTANCE_LABEL',
  'ORCA_DEV_DOCK_TITLE',
  'ORCA_DEV_RENDERER_PORT'
]

export function getAppDataDir(env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    return path.join(env.HOME ?? '', 'Library', 'Application Support')
  }
  if (platform === 'win32') {
    return env.APPDATA ?? path.join(env.USERPROFILE ?? '', 'AppData', 'Roaming')
  }
  return env.XDG_CONFIG_HOME || path.join(env.HOME ?? '', '.config')
}

export function getSharedDevUserDataPath(env = process.env, platform = process.platform) {
  return path.join(getAppDataDir(env, platform), SHARED_DEV_PROFILE_DIR_NAME)
}

export function getWorktreeDevProfilesRoot(env = process.env, platform = process.platform) {
  return path.join(getAppDataDir(env, platform), WORKTREE_DEV_PROFILES_DIR_NAME)
}

export function getWorktreeDevUserDataPath(
  instanceKey,
  env = process.env,
  platform = process.platform
) {
  const name = createHash('sha1').update(instanceKey).digest('hex').slice(0, 10)
  return path.join(getWorktreeDevProfilesRoot(env, platform), name)
}

export function sameFilesystemPath(left, right, platform = process.platform) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isLinkedWorktree(repoRoot) {
  try {
    // Linked worktrees have a `.git` file pointing at the main checkout's git dir.
    return lstatSync(path.join(repoRoot, '.git')).isFile()
  } catch {
    return false
  }
}

// Nested dev launches must derive their own worktree identity instead of inheriting the parent's.
export function dropInheritedDevInstanceEnv(env, repoRoot) {
  const inheritedRoot = env.ORCA_DEV_REPO_ROOT
  if (!inheritedRoot || sameFilesystemPath(inheritedRoot, repoRoot)) {
    return
  }
  // An explicit override differs from the parent app's own userData; an inherited one matches it.
  if (env.ORCA_DEV_USER_DATA_PATH && env.ORCA_DEV_USER_DATA_PATH === env.ORCA_USER_DATA_PATH) {
    delete env.ORCA_DEV_USER_DATA_PATH
  }
  for (const key of RUNNER_DERIVED_ENV_KEYS) {
    delete env[key]
  }
}

/** Precedence: ORCA_DEV_USER_DATA_PATH, then --shared/--worktree-profile or ORCA_DEV_PROFILE, then checkout type. */
export function resolveDevProfile({
  repoRoot,
  instanceKey = repoRoot,
  mode,
  env = process.env,
  platform = process.platform
}) {
  if (env.ORCA_DEV_USER_DATA_PATH) {
    return { kind: 'custom', userDataPath: path.resolve(env.ORCA_DEV_USER_DATA_PATH) }
  }
  const requested = mode ?? (env.ORCA_DEV_PROFILE || undefined)
  if (requested !== undefined && !DEV_PROFILE_MODES.includes(requested)) {
    throw new Error(
      `ORCA_DEV_PROFILE must be one of ${DEV_PROFILE_MODES.join(', ')} (got ${JSON.stringify(requested)})`
    )
  }
  // Why the main checkout keeps orca-dev: it is the long-lived profile developers already use.
  const kind = requested ?? (isLinkedWorktree(repoRoot) ? 'worktree' : 'shared')
  return kind === 'shared'
    ? { kind, userDataPath: getSharedDevUserDataPath(env, platform) }
    : { kind, userDataPath: getWorktreeDevUserDataPath(instanceKey, env, platform) }
}

export function writeWorktreeProfileMarker(userDataPath, { repoRoot, instanceKey, gitCommonDir }) {
  mkdirSync(userDataPath, { recursive: true, mode: 0o700 })
  const markerPath = path.join(userDataPath, WORKTREE_PROFILE_MARKER_FILE)
  const marker = { version: 1, repoRoot, instanceKey, gitCommonDir: gitCommonDir ?? null }
  const serialized = `${JSON.stringify(marker, null, 2)}\n`
  try {
    if (readFileSync(markerPath, 'utf8') === serialized) {
      return
    }
  } catch {}
  writeFileSync(markerPath, serialized, { mode: 0o600 })
}

export function readWorktreeProfileMarker(userDataPath) {
  try {
    const marker = JSON.parse(
      readFileSync(path.join(userDataPath, WORKTREE_PROFILE_MARKER_FILE), 'utf8')
    )
    return marker?.version === 1 && typeof marker.repoRoot === 'string' ? marker : null
  } catch {
    return null
  }
}

export function getDevInstanceRecordPath(repoRoot) {
  return path.join(repoRoot, 'out', 'dev-instance.json')
}

export function writeDevInstanceRecord(repoRoot, record) {
  const recordPath = getDevInstanceRecordPath(repoRoot)
  mkdirSync(path.dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`)
}

export function readDevInstanceRecord(repoRoot) {
  try {
    const record = JSON.parse(readFileSync(getDevInstanceRecordPath(repoRoot), 'utf8'))
    return typeof record?.userData === 'string' ? record : null
  } catch {
    return null
  }
}

/** The CLI follows the profile its worktree's dev app last used, so `--shared-profile` runs stay reachable. */
export function resolveDevCliUserDataPath({
  repoRoot,
  env = process.env,
  platform = process.platform
}) {
  dropInheritedDevInstanceEnv(env, repoRoot)
  if (env.ORCA_DEV_USER_DATA_PATH || env.ORCA_DEV_PROFILE) {
    return resolveDevProfile({ repoRoot, instanceKey: env.ORCA_DEV_INSTANCE_KEY, env, platform })
      .userDataPath
  }
  const record = readDevInstanceRecord(repoRoot)
  // Custom profiles are often temporary; they keep requiring an explicit ORCA_DEV_USER_DATA_PATH.
  if (record && record.profile !== 'custom' && existsSync(record.userData)) {
    return record.userData
  }
  return resolveDevProfile({ repoRoot, instanceKey: env.ORCA_DEV_INSTANCE_KEY, env, platform })
    .userDataPath
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (error) => {
      try {
        server.close()
      } catch {}
      // Hosts without IPv6 cannot have a conflicting ::1 listener.
      resolve(host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error?.code))
    })
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen({ port, host, exclusive: true })
  })
}

// Why both loopbacks: Vite binds `localhost`, which resolves to ::1 first on some hosts.
export async function isPortFree(port) {
  return (await canListen(port, '127.0.0.1')) && (await canListen(port, '::1'))
}

/** Deterministic per key so restarts reuse a port; sweeps forward when it is taken. */
export async function pickInstancePort(seedKey, { base, spread }, isFree = isPortFree) {
  const seed = Number.parseInt(createHash('sha1').update(seedKey).digest('hex').slice(0, 8), 16)
  const start = base + (seed % spread)
  for (let offset = 0; offset < PORT_SWEEP; offset++) {
    if (await isFree(start + offset)) {
      return start + offset
    }
  }
  return null
}

export function parsePortValue(raw) {
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 1 || value > 65535 || String(value) !== raw.trim()) {
    return null
  }
  return value
}

async function resolveEnvOrPickedPort(env, envName, seedKey, range) {
  const raw = env[envName]
  if (raw) {
    const port = parsePortValue(raw)
    if (port !== null) {
      return port
    }
    console.error(
      `[orca-dev] Ignoring invalid ${envName}=${JSON.stringify(raw)}; falling back to probe.`
    )
  }
  return pickInstancePort(seedKey, range)
}

function readUserPassedDebugPort(forwardedArgs) {
  for (let index = 0; index < forwardedArgs.length; index++) {
    const arg = forwardedArgs[index]
    if (arg.startsWith('--remote-debugging-port=')) {
      return parsePortValue(arg.slice('--remote-debugging-port='.length))
    }
    if (arg === '--remote-debugging-port') {
      return parsePortValue(forwardedArgs[index + 1] ?? '')
    }
  }
  return null
}

// Allocate discoverable dev ports for browser agents; Electron Vite reads ORCA_DEV_RENDERER_PORT.
export async function resolveDevInstancePorts({ forwardedArgs, instanceKey, env = process.env }) {
  // Why: exact match (or `=` form) avoids false positives on `--remote-debugging-port-*` flags;
  // `--remote-debugging-pipe` opts into pipe-based debugging, so no port is injected.
  const userPassedPort = forwardedArgs.some(
    (arg) =>
      arg === '--remote-debugging-port' ||
      arg.startsWith('--remote-debugging-port=') ||
      arg === '--remote-debugging-pipe'
  )
  let cdpPort = readUserPassedDebugPort(forwardedArgs)
  let forwardedExtras = []
  if (!userPassedPort) {
    cdpPort = await resolveEnvOrPickedPort(
      env,
      'REMOTE_DEBUGGING_PORT',
      instanceKey,
      CDP_PORT_RANGE
    )
    if (cdpPort !== null) {
      forwardedExtras = [`--remote-debugging-port=${cdpPort}`]
    } else {
      console.error(
        '[orca-dev] No free debug port found in sweep; starting without --remote-debugging-port.'
      )
    }
  }
  const rendererPort = await resolveEnvOrPickedPort(
    env,
    'ORCA_DEV_RENDERER_PORT',
    `renderer:${instanceKey}`,
    RENDERER_PORT_RANGE
  )
  if (rendererPort !== null) {
    env.ORCA_DEV_RENDERER_PORT = String(rendererPort)
  } else {
    delete env.ORCA_DEV_RENDERER_PORT
  }
  return { cdpPort, rendererPort, forwardedExtras }
}

/** Prints one `ORCA_DEV_INSTANCE {json}` stdout line and mirrors it to out/dev-instance.json. */
export function announceDevInstance({ repoRoot, profile, cdpPort, rendererPort }) {
  // Why 127.0.0.1: matches the interface probed (localhost may resolve to ::1 on IPv6-first hosts).
  const instance = {
    userData: profile.userDataPath,
    profile: profile.kind,
    rendererPort,
    rendererUrl: rendererPort === null ? null : `http://localhost:${rendererPort}`,
    cdpPort,
    cdpUrl: cdpPort === null ? null : `http://127.0.0.1:${cdpPort}`,
    repoRoot,
    runnerPid: process.pid
  }
  if (cdpPort !== null) {
    console.error(`[orca-dev] Remote debugging on ${instance.cdpUrl}`)
  }
  console.error(`[orca-dev] Profile (${profile.kind}): ${profile.userDataPath}`)
  writeDevInstanceRecord(repoRoot, instance)
  // Why stdout: agents grep `ORCA_DEV_INSTANCE ` to find the profile and CDP endpoint.
  console.log(`ORCA_DEV_INSTANCE ${JSON.stringify(instance)}`)
  return instance
}
