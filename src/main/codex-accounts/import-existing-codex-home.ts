import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { join, resolve, sep } from 'node:path'

const ORCA_MANAGED_HOME_MARKER = '.orca-managed-home'

/**
 * Resolve and validate a user-selected directory as an importable CODEX_HOME.
 * Does not require Orca ownership — the source is an external home the user already authenticated.
 */
export function resolveImportableCodexHomePath(sourceHomePath: string): string {
  const trimmed = sourceHomePath.trim()
  if (!trimmed) {
    throw new Error('Choose a CODEX_HOME directory to import.')
  }

  const resolved = resolve(trimmed)
  if (!existsSync(resolved)) {
    throw new Error(`CODEX_HOME does not exist: ${resolved}`)
  }

  let stats
  try {
    stats = lstatSync(resolved)
  } catch (error) {
    throw new Error(`Could not inspect CODEX_HOME: ${resolved}`, { cause: error })
  }
  if (!stats.isDirectory()) {
    throw new Error(`CODEX_HOME must be a directory: ${resolved}`)
  }

  const authPath = join(resolved, 'auth.json')
  if (!existsSync(authPath) || !lstatSync(authPath).isFile()) {
    throw new Error(
      `Not a valid CODEX_HOME (missing auth.json): ${resolved}. Sign in with Codex in that directory first, then import again.`
    )
  }

  return resolved
}

/** Refuse to import from inside Orca managed storage (would re-copy Orca's own homes). */
export function assertSourceHomeIsNotManagedStorage(
  sourceHomePath: string,
  managedAccountsRoot: string
): void {
  const sourceReal = safeRealpath(sourceHomePath)
  const managedReal = safeRealpath(managedAccountsRoot)
  if (!sourceReal || !managedReal) {
    return
  }
  const prefix = managedReal.endsWith(sep) ? managedReal : `${managedReal}${sep}`
  if (sourceReal === managedReal || sourceReal.startsWith(prefix)) {
    throw new Error(
      'That directory is already inside Orca managed Codex storage. Pick an external CODEX_HOME (for example ~/.codex-work).'
    )
  }
}

/**
 * Copy an external CODEX_HOME into a freshly created managed home.
 * Preserves auth and credentials; keeps the Orca ownership marker authoritative.
 */
export function copyExistingCodexHomeIntoManaged(params: {
  sourceHomePath: string
  managedHomePath: string
  accountId: string
}): void {
  const { sourceHomePath, managedHomePath, accountId } = params
  const entries = readdirSync(sourceHomePath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === ORCA_MANAGED_HOME_MARKER) {
      continue
    }
    const from = join(sourceHomePath, entry.name)
    const to = join(managedHomePath, entry.name)
    cpSync(from, to, {
      recursive: true,
      force: true,
      // Why: CODEX_HOME often holds symlinks (skills, config overlays); copy
      // contents so the managed home stays self-contained on every host.
      dereference: true
    })
  }
  writeFileSync(join(managedHomePath, ORCA_MANAGED_HOME_MARKER), `${accountId}\n`, 'utf-8')
}

export function readRawAuthJsonFromHome(homePath: string): Record<string, unknown> {
  const authFilePath = join(homePath, 'auth.json')
  const authFileContents = readFileSync(authFilePath, 'utf-8')
  try {
    return JSON.parse(authFileContents) as Record<string, unknown>
  } catch {
    // Why: never echo credential bytes into logs/error UI.
    throw new Error('Codex auth.json is corrupt or not valid JSON')
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    try {
      return resolve(path)
    } catch {
      return null
    }
  }
}
