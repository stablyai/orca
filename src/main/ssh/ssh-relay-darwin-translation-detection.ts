import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'

const PROBE_MARKER = '__ORCA_SSH_RELAY_DARWIN_TRANSLATION__'
const PROBE_TIMEOUT_MS = 15_000
const EVIDENCE_MAX_CHARS = 64

const PROBE_COMMAND = [
  `printf '\n%s\n' '${PROBE_MARKER} BEGIN'`,
  'if command -v sysctl >/dev/null 2>&1; then',
  '  translated=$(sysctl -in sysctl.proc_translated 2>/dev/null) || translated=',
  '  arm64=$(sysctl -in hw.optional.arm64 2>/dev/null) || arm64=',
  `  printf 'translated=%s arm64=%s\n' "$translated" "$arm64"`,
  'fi',
  `printf '%s\n' '${PROBE_MARKER} END'`
].join('\n')

function parseMarker(line: string): 'BEGIN' | 'END' | null {
  const fields = getProcessOutputFields(line, 3)
  if (fields.length !== 2 || fields[0] !== PROBE_MARKER) {
    return null
  }
  return fields[1] === 'BEGIN' || fields[1] === 'END' ? fields[1] : null
}

function classifyTranslation(line: string | undefined): boolean | undefined {
  if (!line || line.length > EVIDENCE_MAX_CHARS) {
    return undefined
  }
  const match = /^translated=(0|1)? arm64=(0|1)?$/.exec(line)
  if (!match) {
    return undefined
  }
  const translated = match[1]
  const arm64 = match[2]
  if (translated === '1') {
    return arm64 === '0' ? undefined : true
  }
  if (translated === '0') {
    return false
  }
  return arm64 === '0' ? false : undefined
}

function parseTranslation(output: string): boolean | undefined {
  let activeLines: string[] | null = null
  let evidenceLine: string | undefined
  let complete = false
  let invalid = false

  for (const line of iterateProcessOutputLines(output)) {
    const marker = parseMarker(line)
    if (marker === 'BEGIN') {
      if (activeLines || complete) {
        invalid = true
      }
      activeLines = []
      continue
    }
    if (marker === 'END') {
      if (!activeLines || activeLines.length !== 1 || complete) {
        invalid = true
        activeLines = null
        continue
      }
      evidenceLine = activeLines[0]
      complete = true
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

  if (invalid || activeLines || !complete) {
    return undefined
  }
  return classifyTranslation(evidenceLine)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function detectSshRelayDarwinProcessTranslation(
  conn: SshConnection,
  { signal }: { signal?: AbortSignal } = {}
): Promise<boolean | undefined> {
  try {
    const output = await execCommand(conn, PROBE_COMMAND, {
      signal,
      timeoutMs: PROBE_TIMEOUT_MS
    })
    return parseTranslation(output)
  } catch (error) {
    // Why: cancellation must settle the caller's work instead of becoming compatibility evidence.
    if (isAbortError(error)) {
      throw error
    }
    return undefined
  }
}
