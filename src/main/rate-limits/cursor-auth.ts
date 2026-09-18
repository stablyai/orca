import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type CursorAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; accessToken: string; source: 'cli' }

export type CursorAuthDeps = {
  authFilePath: string
  readFile: (path: string) => Promise<string>
}

export function getCursorCliAuthPath(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
    return join(appData, 'Cursor', 'auth.json')
  }
  if (platform === 'darwin') {
    return join(home, '.cursor', 'auth.json')
  }
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return join(configHome, 'cursor', 'auth.json')
}

function buildDefaultCursorAuthDeps(): CursorAuthDeps {
  return {
    authFilePath: getCursorCliAuthPath(),
    readFile: (path) => readFile(path, 'utf-8')
  }
}

function isFileNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

export type ReadCursorAuthSessionOptions = {
  deps?: CursorAuthDeps
}

export async function readCursorAuthSession(
  options: ReadCursorAuthSessionOptions = {}
): Promise<CursorAuthReadResult> {
  const deps = options.deps ?? buildDefaultCursorAuthDeps()
  let raw: string
  try {
    raw = await deps.readFile(deps.authFilePath)
  } catch (err) {
    if (isFileNotFound(err)) {
      return { status: 'missing' }
    }
    // Why: filesystem errors embed the full path; never expose local usernames to the renderer.
    return { status: 'error', error: 'Unable to read Cursor auth file' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'error', error: 'Cursor auth file is invalid' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 'error', error: 'Cursor auth file is invalid' }
  }
  const accessToken = 'accessToken' in parsed ? parsed.accessToken : undefined
  // Why: a token-less file (e.g. after logout) means signed out, not a failure.
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return { status: 'missing' }
  }
  return { status: 'ok', accessToken, source: 'cli' }
}
