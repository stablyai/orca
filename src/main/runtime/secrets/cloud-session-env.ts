// Orca Cloud: the session env (secrets, agent placeholders such as CLAUDE_CODE_OAUTH_TOKEN) lives in a
// tmpfs file that the control plane rewrites live (orca-sandbox-env). Shells pick it up through the
// profile hook, but orcad's own process env and its cached login-shell capture are frozen at start, so
// anything orcad spawns directly (chat agents, PTYs launched without a shell) must lay the current file
// over the env it built. Same rules as the hook (image/vm/orca-session-env.sh).
import { readFileSync } from 'node:fs'
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

export type CloudSessionEnvOptions = {
  processEnv?: NodeJS.ProcessEnv
  uid?: number
  read?: (path: string) => string
}

/** Null outside a cloud workspace's orcad, or before the file exists (then nothing changes, as in the hook). */
export function cloudSessionEnv(
  base: Readonly<Record<string, string | undefined>>,
  options: CloudSessionEnvOptions = {}
): CloudSessionEnv | null {
  if (!isCloudWorkspaceOrcad(options.processEnv ?? process.env)) {
    return null
  }
  const uid = options.uid ?? process.getuid?.()
  if (uid === undefined) {
    return null
  }
  let text: string
  try {
    text = (options.read ?? ((path: string) => readFileSync(path, 'utf8')))(sessionEnvFilePath(uid))
  } catch {
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

/** `env` with the current cloud session env laid over it and dropped names removed. */
export function withCloudSessionEnv(
  env: Record<string, string>,
  options?: CloudSessionEnvOptions
): Record<string, string>
export function withCloudSessionEnv(
  env: NodeJS.ProcessEnv,
  options?: CloudSessionEnvOptions
): NodeJS.ProcessEnv
export function withCloudSessionEnv(
  env: Record<string, string | undefined>,
  options: CloudSessionEnvOptions = {}
): Record<string, string | undefined> {
  const current = cloudSessionEnv(env, options)
  if (!current) {
    return env
  }
  const next: Record<string, string | undefined> = { ...env }
  for (const name of current.unset) {
    delete next[name]
  }
  return Object.assign(next, current.set)
}
