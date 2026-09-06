import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type OpenCodeAuthRecord = Record<string, unknown>

/** One provider credential: `"<provider-id>": { "type": "api", "key": "..." }`. */
export type OpenCodeApiKeyRecord = { type: 'api'; key: string }

export type OpenCodeAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; auth: OpenCodeAuthRecord }

/**
 * auth.json locations in OpenCode's own search order: Windows APPDATA, then
 * XDG_DATA_HOME, then the Linux and macOS defaults. Duplicates of an earlier
 * path (e.g. XDG_DATA_HOME pointing at ~/.local/share) are dropped so the
 * first occurrence always wins.
 */
export function getOpenCodeAuthJsonCandidates(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir()
): string[] {
  const candidates = [
    environment.APPDATA ? join(environment.APPDATA, 'opencode', 'auth.json') : null,
    environment.XDG_DATA_HOME ? join(environment.XDG_DATA_HOME, 'opencode', 'auth.json') : null,
    join(homeDirectory, '.local', 'share', 'opencode', 'auth.json'),
    join(homeDirectory, 'Library', 'Application Support', 'opencode', 'auth.json')
  ].filter((candidate): candidate is string => candidate !== null)
  const seen = new Set<string>()
  const unique: string[] = []
  for (const candidate of candidates) {
    const key = resolve(candidate)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(candidate)
  }
  return unique
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

// Why: never echo file contents or raw OS messages into user-visible errors;
// a partially-written auth.json can carry credential fragments.
function describeReadError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code ? `Failed to read OpenCode auth.json (${code})` : 'Failed to read OpenCode auth.json'
}

/**
 * Read-only read of the first existing OpenCode auth.json. Never writes and
 * never throws: parse or filesystem failures surface as a sanitized error.
 */
export async function readOpenCodeAuthJson(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir()
): Promise<OpenCodeAuthReadResult> {
  for (const candidate of getOpenCodeAuthJsonCandidates(environment, homeDirectory)) {
    let raw: string
    try {
      raw = await readFile(candidate, 'utf-8')
    } catch (error) {
      if (isMissingPathError(error)) {
        continue
      }
      return { status: 'error', error: describeReadError(error) }
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'error', error: 'OpenCode auth.json is invalid' }
      }
      return { status: 'ok', auth: parsed as OpenCodeAuthRecord }
    } catch {
      return { status: 'error', error: 'OpenCode auth.json is not valid JSON' }
    }
  }
  return { status: 'missing' }
}

/**
 * Strict `{ type: 'api', key }` record lookup. The key must be nonempty after
 * trimming and the type must match exactly — anything else reads as "not
 * configured" instead of feeding a partial record downstream.
 */
export function getOpenCodeApiKeyRecord(
  auth: OpenCodeAuthRecord,
  providerId: string
): OpenCodeApiKeyRecord | null {
  const entry: unknown = auth[providerId]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return null
  }
  const record = entry as Record<string, unknown>
  if (record.type !== 'api' || typeof record.key !== 'string' || record.key.trim().length === 0) {
    return null
  }
  return { type: 'api', key: record.key }
}
