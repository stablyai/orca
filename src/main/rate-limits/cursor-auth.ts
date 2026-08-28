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
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
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
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  const configHome = env.XDG_CONFIG_HOME ?? join(home, '.config')
  return join(configHome, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

/** True when `candidate` exists and is executable (on Windows: exists). */
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

/** Prefers `cursor-agent`, then bare `agent`, resolved from PATH. */
async function resolveCursorCliProgram(): Promise<string | null> {
  for (const name of CURSOR_CLI_CANDIDATES) {
    const resolved = await resolveExecutableOnPath(name, process.platform, process.env)
    if (resolved) {
      return resolved
    }
  }
  return null
}

/** Exported for unit testing; not part of the injectable `CursorAuthDeps` seam. */
export function extractIdeAccessToken(row: { value: unknown } | undefined): string | null {
  if (!row || typeof row.value !== 'string' || row.value.length === 0) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(row.value)
    // Why: a value that parses as JSON but isn't a non-empty string (object,
    // number, etc.) is not a valid token — never fall through to the raw JSON text.
    return typeof parsed === 'string' && parsed.length > 0 ? parsed : null
  } catch {
    // Why: some VSCode-family storage items are stored as raw strings rather
    // than JSON-encoded ones; fall back to the raw value.
    return row.value
  }
}

/** Reads `cursorAuth/accessToken` from Cursor's `state.vscdb`; never throws. */
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

/** Production IO wiring for {@link readCursorAuthSession}. */
function buildDefaultCursorAuthDeps(): CursorAuthDeps {
  return {
    runProcess,
    resolveCliProgram: resolveCursorCliProgram,
    ideDbPath: getCursorIdeDbPath(),
    readIdeAccessToken: readIdeAccessTokenFromDb
  }
}

/** Parses `cursor-agent status --format json` stdout for a non-empty access token. */
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
async function readFromCli(
  deps: CursorAuthDeps,
  signal?: AbortSignal
): Promise<CursorAuthReadResult | null> {
  let program: string | null
  try {
    program = await deps.resolveCliProgram()
  } catch {
    return null
  }
  if (!program) {
    return null
  }
  if (signal?.aborted) {
    return null
  }
  let result: ProcessResult
  try {
    result = await deps.runProcess({
      program,
      args: ['status', '--format', 'json'],
      timeoutMs: CLI_STATUS_TIMEOUT_MS,
      signal
    })
  } catch {
    return { status: 'error', error: CLI_SPAWN_ERROR_MESSAGE }
  }
  if (signal?.aborted) {
    return null
  }
  const accessToken = extractCliAccessToken(result.stdout)
  return accessToken ? { status: 'ok', accessToken, source: 'cli' } : null
}

export type ReadCursorAuthSessionOptions = {
  deps?: CursorAuthDeps
  signal?: AbortSignal
}

/** Reads an existing Cursor CLI/IDE session; never runs login. Honors `signal` for CLI spawn. */
export async function readCursorAuthSession(
  options: ReadCursorAuthSessionOptions = {}
): Promise<CursorAuthReadResult> {
  const deps = options.deps ?? buildDefaultCursorAuthDeps()
  const cliResult = await readFromCli(deps, options.signal)
  if (cliResult?.status === 'ok') {
    return cliResult
  }
  if (options.signal?.aborted) {
    return { status: 'missing' }
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

  return cliResult ?? { status: 'missing' }
}
