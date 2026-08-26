import { access, constants as fsConstants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  runProcess,
  type ProcessResult,
  type ProcessSpec
} from '../../shared/child-process/run-process'
import SyncDatabase from '../sqlite/sync-database'

export type CursorAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; accessToken: string; source: 'cli' | 'ide' }

/**
 * Injectable so tests never spawn `cursor-agent`/`agent` or open a real
 * `state.vscdb` — every field is real production IO by default.
 */
export type CursorAuthDeps = {
  runProcess: (spec: ProcessSpec) => Promise<ProcessResult>
  /** Resolves an absolute path to `cursor-agent` (preferred) or `agent`, or null if neither is on PATH. */
  resolveCliProgram: () => Promise<string | null>
  ideDbPath: string
  /** Reads `cursorAuth/accessToken` from the IDE's global storage db. Never throws; returns null on any failure. */
  readIdeAccessToken: (dbPath: string) => string | null
}

const CURSOR_CLI_CANDIDATES = ['cursor-agent', 'agent'] as const
const CLI_STATUS_TIMEOUT_MS = 10_000
const IDE_AUTH_TOKEN_KEY = 'cursorAuth/accessToken'
// Why: a generic, fixed message — never the raw thrown error — so a spawn
// failure (which can echo back argv) can never surface a token.
const CLI_SPAWN_ERROR_MESSAGE = 'Unable to run the Cursor CLI'

/** Cursor (VSCode-based) stores its global storage db at the same relative path as VSCode. */
export function getCursorIdeDbPath(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  if (platform === 'darwin') {
    return join(
      home,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb'
    )
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  return join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

async function isExecutableCandidate(candidate: string, isWin: boolean): Promise<boolean> {
  try {
    await access(candidate, isWin ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolves `name` to an absolute path on PATH (Windows: PATHEXT permutations). */
async function resolveExecutableOnPath(
  name: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const isWin = platform === 'win32'
  const pathValue = env.PATH ?? env.Path ?? ''
  const dirs = pathValue.split(isWin ? ';' : ':').filter(Boolean)
  const extensions = isWin
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`)
      if (await isExecutableCandidate(candidate, isWin)) {
        return candidate
      }
    }
  }
  return null
}

async function resolveCursorCliProgram(): Promise<string | null> {
  for (const name of CURSOR_CLI_CANDIDATES) {
    const resolved = await resolveExecutableOnPath(name, process.platform, process.env)
    if (resolved) {
      return resolved
    }
  }
  return null
}

function extractIdeAccessToken(row: { value: unknown } | undefined): string | null {
  if (!row || typeof row.value !== 'string' || row.value.length === 0) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (typeof parsed === 'string' && parsed.length > 0) {
      return parsed
    }
  } catch {
    // Why: some VSCode-family storage items are stored as raw strings rather
    // than JSON-encoded ones; fall back to the raw value below.
  }
  return row.value
}

function readIdeAccessTokenFromDb(dbPath: string): string | null {
  let db: InstanceType<typeof SyncDatabase> | undefined
  try {
    db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(IDE_AUTH_TOKEN_KEY) as
      | { value: unknown }
      | undefined
    return extractIdeAccessToken(row)
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // Read-only close failures cannot change the result already collected.
    }
  }
}

function buildDefaultCursorAuthDeps(): CursorAuthDeps {
  return {
    runProcess,
    resolveCliProgram: resolveCursorCliProgram,
    ideDbPath: getCursorIdeDbPath(),
    readIdeAccessToken: readIdeAccessTokenFromDb
  }
}

function extractCliAccessToken(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { auth?: { accessToken?: unknown } }
    const token = parsed?.auth?.accessToken
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

/** Returns a result when the CLI produced one, or null to fall through to the IDE db. */
async function readFromCli(deps: CursorAuthDeps): Promise<CursorAuthReadResult | null> {
  let program: string | null
  try {
    program = await deps.resolveCliProgram()
  } catch {
    return null
  }
  if (!program) {
    return null
  }
  let result: ProcessResult
  try {
    result = await deps.runProcess({
      program,
      args: ['status', '--format', 'json'],
      timeoutMs: CLI_STATUS_TIMEOUT_MS
    })
  } catch {
    return { status: 'error', error: CLI_SPAWN_ERROR_MESSAGE }
  }
  const accessToken = extractCliAccessToken(result.stdout)
  return accessToken ? { status: 'ok', accessToken, source: 'cli' } : null
}

// Why: Orca never runs `cursor-agent login`; it only reads the session the CLI
// or Cursor IDE already established.
export async function readCursorAuthSession(
  deps: CursorAuthDeps = buildDefaultCursorAuthDeps()
): Promise<CursorAuthReadResult> {
  const cliResult = await readFromCli(deps)
  if (cliResult) {
    return cliResult
  }

  let ideToken: string | null
  try {
    ideToken = deps.readIdeAccessToken(deps.ideDbPath)
  } catch {
    // Why: a db read failure is indistinguishable from "no Cursor IDE
    // installed" from the caller's perspective, and never writes the db.
    ideToken = null
  }
  if (ideToken) {
    return { status: 'ok', accessToken: ideToken, source: 'ide' }
  }

  return { status: 'missing' }
}
