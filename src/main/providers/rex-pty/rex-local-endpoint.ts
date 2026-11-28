import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { homedir } from 'node:os'

/** Resolve parent aliases (e.g. macOS /var) once, then use only the checked path. */
export async function validateRexLocalEndpoint(path: string): Promise<string> {
  if (!isAbsolute(path) || !process.getuid || path.includes('\0')) {
    throw new Error('Rex requires an absolute local Unix socket')
  }
  const uid = process.getuid()
  const parent = await realpath(dirname(path))
  let directory: string = sep
  // Walk root to leaf: each existing entry must be protected by its already checked parent.
  for (const component of ['', ...parent.split(sep).filter(Boolean)]) {
    directory = join(directory, component)
    const info = await lstat(directory)
    if (
      !info.isDirectory() ||
      (info.uid !== 0 && info.uid !== uid) ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    ) {
      throw new Error('Rex socket requires trusted ancestor directories')
    }
  }
  const endpoint = join(parent, basename(path))
  const info = await lstat(endpoint)
  if (!info.isSocket() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error('Rex socket must be owned by the current user with owner-only permissions')
  }
  return endpoint
}

export function defaultRexLocalEndpoint(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (platform === 'darwin') {
    return join(home, 'Library/Application Support/rex/server.sock')
  }
  if (platform !== 'linux') {
    return null
  }
  // Rex uses the runtime directory when present, else its XDG state directory.
  if (env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR)) {
    return join(env.XDG_RUNTIME_DIR, 'rex/server.sock')
  }
  const state =
    env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : join(home, '.local/state')
  return join(state, 'rex/run/server.sock')
}
