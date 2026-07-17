import {
  getProcessOutputFields,
  iterateProcessOutputLines,
  PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS
} from '../../shared/process-output-field-scanner'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshRelayLinuxHostEvidence } from './ssh-relay-artifact-selector'

type SshRelayLinuxLibcEvidence = SshRelayLinuxHostEvidence['libc']
type ProbeSource = 'getconf' | 'ldd' | 'loader'
type LibcCandidate = Exclude<SshRelayLinuxLibcEvidence, { family: 'unknown' }>

const PROBE_MARKER = '__ORCA_SSH_RELAY_LIBC__'
const PROBE_TIMEOUT_MS = 15_000
const MAX_SEGMENT_LINES = 8

const PROBE_COMMAND = [
  `printf '\n%s\n' '${PROBE_MARKER} BEGIN getconf'`,
  'if command -v getconf >/dev/null 2>&1; then getconf GNU_LIBC_VERSION 2>&1 || :; fi',
  `printf '%s\n' '${PROBE_MARKER} END getconf'`,
  `printf '%s\n' '${PROBE_MARKER} BEGIN ldd'`,
  'if command -v ldd >/dev/null 2>&1; then ldd --version 2>&1 || :; fi',
  `printf '%s\n' '${PROBE_MARKER} END ldd'`,
  'for orca_loader in /lib/ld-musl-*.so.1 /usr/lib/ld-musl-*.so.1 /lib/*/ld-musl-*.so.1 /usr/lib/*/ld-musl-*.so.1; do',
  '  if test -x "$orca_loader"; then',
  `    printf '%s\n' '${PROBE_MARKER} BEGIN loader'`,
  '    "$orca_loader" --version 2>&1 || :',
  `    printf '%s\n' '${PROBE_MARKER} END loader'`,
  '    break',
  '  fi',
  'done'
].join('\n')

type ParsedSegments = {
  invalid: boolean
  segments: Partial<Record<ProbeSource, string[]>>
}

function parseMarker(line: string): { boundary: 'BEGIN' | 'END'; source: ProbeSource } | null {
  const fields = getProcessOutputFields(line, 4)
  if (fields.length !== 3 || fields[0] !== PROBE_MARKER) {
    return null
  }
  const boundary = fields[1]
  const source = fields[2]
  if (
    (boundary !== 'BEGIN' && boundary !== 'END') ||
    (source !== 'getconf' && source !== 'ldd' && source !== 'loader')
  ) {
    return null
  }
  return { boundary, source }
}

function parseMarkedSegments(output: string): ParsedSegments {
  const segments: ParsedSegments['segments'] = {}
  let active: { source: ProbeSource; lines: string[] } | null = null
  let invalid = false

  for (const line of iterateProcessOutputLines(output)) {
    const marker = parseMarker(line)
    if (!marker) {
      if (active) {
        if (
          active.lines.length >= MAX_SEGMENT_LINES ||
          line.length > PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS
        ) {
          invalid = true
        } else {
          active.lines.push(line)
        }
      }
      continue
    }

    if (marker.boundary === 'BEGIN') {
      if (active) {
        invalid = true
      }
      active = { source: marker.source, lines: [] }
      continue
    }

    if (!active || active.source !== marker.source || segments[marker.source] !== undefined) {
      invalid = true
      active = null
      continue
    }
    segments[marker.source] = active.lines
    active = null
  }

  return { segments, invalid: invalid || active !== null }
}

function isNumericVersion(value: string | undefined): value is string {
  return value !== undefined && /^\d+\.\d+(?:\.\d+){0,2}$/u.test(value)
}

function parseGetconf(lines: string[] | undefined): LibcCandidate | null {
  if (!lines || lines.length !== 1) {
    return null
  }
  const fields = getProcessOutputFields(lines[0], 3)
  return fields.length === 2 && fields[0] === 'glibc' && isNumericVersion(fields[1])
    ? { family: 'glibc', version: fields[1] }
    : null
}

function parseMusl(lines: string[]): LibcCandidate | null {
  const hasMuslHeader = lines.some((line) => {
    const fields = getProcessOutputFields(line, 3)
    return fields[0]?.toLowerCase() === 'musl' && fields[1]?.toLowerCase() === 'libc'
  })
  if (!hasMuslHeader) {
    return null
  }
  for (const line of lines) {
    const fields = getProcessOutputFields(line, 3)
    if (fields.length === 2 && fields[0] === 'Version' && isNumericVersion(fields[1])) {
      return { family: 'musl', version: fields[1] }
    }
  }
  return null
}

function parseGlibcLdd(lines: string[]): LibcCandidate | null {
  for (const line of lines) {
    const fields = getProcessOutputFields(line, 32)
    const normalized = line.toLowerCase()
    const version = fields.at(-1)
    if (
      fields[0] === 'ldd' &&
      (normalized.includes('glibc') || normalized.includes('gnu libc')) &&
      isNumericVersion(version)
    ) {
      return { family: 'glibc', version }
    }
  }
  return null
}

function addCandidate(
  candidates: Map<string, LibcCandidate>,
  candidate: LibcCandidate | null
): void {
  if (candidate) {
    candidates.set(`${candidate.family}:${candidate.version ?? ''}`, candidate)
  }
}

function parseLibcEvidence(output: string): SshRelayLinuxLibcEvidence {
  const parsed = parseMarkedSegments(output)
  if (parsed.invalid) {
    return Object.freeze({ family: 'unknown' })
  }

  const candidates = new Map<string, LibcCandidate>()
  addCandidate(candidates, parseGetconf(parsed.segments.getconf))
  if (parsed.segments.ldd) {
    addCandidate(candidates, parseMusl(parsed.segments.ldd))
    addCandidate(candidates, parseGlibcLdd(parsed.segments.ldd))
  }
  if (parsed.segments.loader) {
    addCandidate(candidates, parseMusl(parsed.segments.loader))
  }

  if (candidates.size !== 1) {
    return Object.freeze({ family: 'unknown' })
  }
  const candidate = candidates.values().next().value
  return candidate ? Object.freeze({ ...candidate }) : Object.freeze({ family: 'unknown' })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function detectSshRelayLinuxLibc(
  conn: SshConnection,
  { signal }: { signal?: AbortSignal } = {}
): Promise<SshRelayLinuxLibcEvidence> {
  try {
    const output = await execCommand(conn, PROBE_COMMAND, {
      signal,
      timeoutMs: PROBE_TIMEOUT_MS
    })
    return parseLibcEvidence(output)
  } catch (error) {
    // Why: cancellation must not be downgraded into compatibility evidence and trigger later legacy.
    if (isAbortError(error)) {
      throw error
    }
    return Object.freeze({ family: 'unknown' })
  }
}
