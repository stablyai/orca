import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
import type { SshConnection } from './ssh-connection'
import { isSshRelayLinuxKernelRelease } from './ssh-relay-artifact-selector'
import { execCommand } from './ssh-relay-deploy-helpers'

const PROBE_MARKER = '__ORCA_SSH_RELAY_KERNEL__'
const PROBE_TIMEOUT_MS = 15_000

const PROBE_COMMAND = [
  `printf '\n%s\n' '${PROBE_MARKER} BEGIN'`,
  'if command -v uname >/dev/null 2>&1; then uname -r 2>&1 || :; fi',
  `printf '%s\n' '${PROBE_MARKER} END'`
].join('\n')

function parseMarker(line: string): 'BEGIN' | 'END' | null {
  const fields = getProcessOutputFields(line, 3)
  if (fields.length !== 2 || fields[0] !== PROBE_MARKER) {
    return null
  }
  return fields[1] === 'BEGIN' || fields[1] === 'END' ? fields[1] : null
}

function parseKernelRelease(output: string): string | undefined {
  let activeLines: string[] | null = null
  let release: string | undefined
  let invalid = false

  for (const line of iterateProcessOutputLines(output)) {
    const marker = parseMarker(line)
    if (marker === 'BEGIN') {
      if (activeLines || release !== undefined) {
        invalid = true
      }
      activeLines = []
      continue
    }
    if (marker === 'END') {
      if (!activeLines || activeLines.length !== 1 || release !== undefined) {
        invalid = true
        activeLines = null
        continue
      }
      release = activeLines[0]
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

  if (invalid || activeLines || !isSshRelayLinuxKernelRelease(release)) {
    return undefined
  }
  return release
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function detectSshRelayLinuxKernelRelease(
  conn: SshConnection,
  { signal }: { signal?: AbortSignal } = {}
): Promise<string | undefined> {
  try {
    const output = await execCommand(conn, PROBE_COMMAND, {
      signal,
      timeoutMs: PROBE_TIMEOUT_MS
    })
    return parseKernelRelease(output)
  } catch (error) {
    // Why: cancellation must settle the caller's work instead of becoming compatibility evidence.
    if (isAbortError(error)) {
      throw error
    }
    return undefined
  }
}
