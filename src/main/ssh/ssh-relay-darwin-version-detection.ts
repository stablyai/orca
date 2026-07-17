import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'

const PROBE_MARKER = '__ORCA_SSH_RELAY_DARWIN_VERSION__'
const PROBE_TIMEOUT_MS = 15_000
const VERSION_MAX_CHARS = 64

const PROBE_COMMAND = [
  `printf '\n%s\n' '${PROBE_MARKER} BEGIN'`,
  'if command -v sw_vers >/dev/null 2>&1; then sw_vers -productVersion 2>&1 || :; fi',
  `printf '%s\n' '${PROBE_MARKER} END'`
].join('\n')

function parseMarker(line: string): 'BEGIN' | 'END' | null {
  const fields = getProcessOutputFields(line, 3)
  if (fields.length !== 2 || fields[0] !== PROBE_MARKER) {
    return null
  }
  return fields[1] === 'BEGIN' || fields[1] === 'END' ? fields[1] : null
}

function isDarwinProductVersion(value: string | undefined): value is string {
  if (!value || value.length > VERSION_MAX_CHARS || !/^\d+(?:\.\d+){1,3}$/.test(value)) {
    return false
  }
  return value.split('.').map(Number).every(Number.isSafeInteger)
}

function parseDarwinProductVersion(output: string): string | undefined {
  let activeLines: string[] | null = null
  let version: string | undefined
  let invalid = false

  for (const line of iterateProcessOutputLines(output)) {
    const marker = parseMarker(line)
    if (marker === 'BEGIN') {
      if (activeLines || version !== undefined) {
        invalid = true
      }
      activeLines = []
      continue
    }
    if (marker === 'END') {
      if (!activeLines || activeLines.length !== 1 || version !== undefined) {
        invalid = true
        activeLines = null
        continue
      }
      version = activeLines[0]
      activeLines = null
      continue
    }
    if (activeLines) {
      if (activeLines.length === 1) {
        invalid = true
      } else {
        activeLines.push(line)
      }
    }
  }

  if (invalid || activeLines || !isDarwinProductVersion(version)) {
    return undefined
  }
  return version
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function detectSshRelayDarwinVersion(
  conn: SshConnection,
  { signal }: { signal?: AbortSignal } = {}
): Promise<string | undefined> {
  try {
    const output = await execCommand(conn, PROBE_COMMAND, {
      signal,
      timeoutMs: PROBE_TIMEOUT_MS
    })
    return parseDarwinProductVersion(output)
  } catch (error) {
    // Why: cancellation must settle the caller's work instead of becoming compatibility evidence.
    if (isAbortError(error)) {
      throw error
    }
    return undefined
  }
}
