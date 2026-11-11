// Orca Cloud: the session env (secrets, agent placeholders such as CLAUDE_CODE_OAUTH_TOKEN) lives in a
// tmpfs file that the control plane rewrites live (orca-sandbox-env). Shells pick it up through the
// profile hook, but orcad's own process env and its cached login-shell capture are frozen at start, so
// anything orcad spawns directly (chat agents, PTYs launched without a shell) must lay the current file
// over the env it built. Same rules as the hook (image/vm/orca-session-env.sh).
//
// The file is kept in memory and reread when its directory changes (a watch, no polling), so spawn paths
// read it without blocking on disk.
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isCloudWorkspaceOrcad, sessionEnvFilePath } from './session-env-names'

const NAME = /^[A-Z_][A-Z0-9_]*$/

function reserved(name: string): boolean {
  return (
    name.startsWith('ORCA_') ||
    name === 'PATH' ||
    name === 'HOME' ||
    name.startsWith('LD_') ||
    name.startsWith('DYLD_')
  )
}

export type CloudSessionEnv = {
  /** Current values, plus ORCA_SESSION_ENV_NAMES listing them. */
  set: Record<string, string>
  /** Names `base` got from an older session env that the current one no longer has. */
  unset: string[]
}

/** The overlay for `base` from the file's text; null text (no file) changes nothing, as in the hook. */
export function cloudSessionEnvFromText(
  base: Readonly<Record<string, string | undefined>>,
  text: string | null
): CloudSessionEnv | null {
  if (text === null) {
    return null
  }
  const set: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    const name = at > 0 ? line.slice(0, at) : ''
    if (!NAME.test(name) || reserved(name)) {
      continue
    }
    set[name] = Buffer.from(line.slice(at + 1), 'base64').toString('utf8')
  }
  const names = Object.keys(set)
  const unset = (base.ORCA_SESSION_ENV_NAMES ?? '')
    .split(/\s+/)
    .filter((name) => name && !(name in set))
  return { set: { ...set, ORCA_SESSION_ENV_NAMES: names.join(' ') }, unset }
}

/** `env` with `overlay` laid over it and dropped names removed. */
export function applyCloudSessionEnv(
  env: Record<string, string>,
  overlay: CloudSessionEnv | null
): Record<string, string>
export function applyCloudSessionEnv(
  env: NodeJS.ProcessEnv,
  overlay: CloudSessionEnv | null
): NodeJS.ProcessEnv
export function applyCloudSessionEnv(
  env: Record<string, string | undefined>,
  overlay: CloudSessionEnv | null
): Record<string, string | undefined> {
  if (!overlay) {
    return env
  }
  const next: Record<string, string | undefined> = { ...env }
  for (const name of overlay.unset) {
    delete next[name]
  }
  return Object.assign(next, overlay.set)
}

type Cache = { path: string; text: string | null; loaded: Promise<void>; watcher: FSWatcher | null }
let cache: Cache | null = null

async function reload(into: Cache): Promise<void> {
  try {
    into.text = await readFile(into.path, 'utf8')
  } catch {
    into.text = null
  }
}

/** Starts the in-memory copy once per process; null outside a cloud workspace's orcad. */
function cloudCache(): Cache | null {
  if (cache) {
    return cache
  }
  const uid = process.getuid?.()
  if (!isCloudWorkspaceOrcad() || uid === undefined) {
    return null
  }
  const created: Cache = {
    path: sessionEnvFilePath(uid),
    text: null,
    loaded: Promise.resolve(),
    watcher: null
  }
  created.loaded = reload(created)
  try {
    // orca-sandbox-env replaces the file by rename, so watch the directory.
    created.watcher = watch(dirname(created.path), { persistent: false }, () => {
      created.loaded = reload(created)
    })
    created.watcher.on('error', () => {})
  } catch {
    // No directory yet: async reads go to disk each time instead.
    created.watcher = null
  }
  cache = created
  return created
}

/** The live overlay for `base`, read fresh when unwatched (async paths: structured agent launches). */
export async function liveCloudSessionEnv(
  base: Readonly<Record<string, string | undefined>>
): Promise<CloudSessionEnv | null> {
  const current = cloudCache()
  if (!current) {
    return null
  }
  if (!current.watcher) {
    current.loaded = reload(current)
  }
  await current.loaded
  return cloudSessionEnvFromText(base, current.text)
}

/** The last-read overlay for `base`, without waiting (sync spawn paths). */
export function cachedCloudSessionEnv(
  base: Readonly<Record<string, string | undefined>>
): CloudSessionEnv | null {
  const current = cloudCache()
  return current ? cloudSessionEnvFromText(base, current.text) : null
}

export function resetCloudSessionEnvCacheForTests(): void {
  cache?.watcher?.close()
  cache = null
}
