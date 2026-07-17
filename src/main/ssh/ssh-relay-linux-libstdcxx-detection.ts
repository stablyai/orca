import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
import type { SshConnection } from './ssh-connection'
import type { SshRelayLinuxHostEvidence } from './ssh-relay-artifact-selector'
import { execCommand } from './ssh-relay-deploy-helpers'

export type SshRelayLinuxLibstdcxxEvidence = Required<
  Pick<SshRelayLinuxHostEvidence, 'libstdcxxVersion' | 'glibcxxVersion'>
>

type LibraryCandidate = SshRelayLinuxLibstdcxxEvidence & { path: string }
type ProbeMarker = 'BEGIN' | 'END' | 'LIBRARY_BEGIN' | 'LIBRARY_END' | 'INVALID'

const PROBE_MARKER = '__ORCA_SSH_RELAY_LIBSTDCXX__'
const PROBE_TIMEOUT_MS = 15_000
const MAX_LIBRARIES = 8
const MAX_SYMBOLS_PER_LIBRARY = 256
const MAX_LIBRARY_PATH_CHARS = 1024

// Why: loader overrides make cache evidence ambiguous; staged bundled Node remains authoritative.
const PROBE_COMMAND = [
  `printf '\n%s\n' '${PROBE_MARKER} BEGIN'`,
  'if [ -z "${LD_LIBRARY_PATH-}" ] && [ -z "${LD_PRELOAD-}" ] && command -v readlink >/dev/null 2>&1 && command -v grep >/dev/null 2>&1; then',
  '  if command -v ldconfig >/dev/null 2>&1; then orca_ldconfig=ldconfig',
  '  elif [ -x /sbin/ldconfig ]; then orca_ldconfig=/sbin/ldconfig',
  '  elif [ -x /usr/sbin/ldconfig ]; then orca_ldconfig=/usr/sbin/ldconfig',
  '  else orca_ldconfig=',
  '  fi',
  '  if [ -n "$orca_ldconfig" ]; then',
  '    "$orca_ldconfig" -p 2>/dev/null | while IFS= read -r orca_line; do',
  '      case "$orca_line" in',
  "        *libstdc++.so.6*'=>'*)",
  '          orca_path=${orca_line##*=> }',
  '          orca_real=$(readlink -f "$orca_path" 2>/dev/null) || continue',
  '          orca_file=${orca_real##*/}',
  '          case "$orca_file" in libstdc++.so.*.*.*) ;; *) continue ;; esac',
  '          orca_libraries=$((${orca_libraries:-0} + 1))',
  `          if [ "$orca_libraries" -gt ${MAX_LIBRARIES} ]; then`,
  `            printf '%s\n' '${PROBE_MARKER} LIBRARY_OVERFLOW'`,
  '            break',
  '          fi',
  `          printf '%s\n' '${PROBE_MARKER} LIBRARY_BEGIN'`,
  '          printf \'path=%s\\nfile=%s\\n\' "$orca_real" "$orca_file"',
  '          LC_ALL=C grep -ao \'GLIBCXX_[0-9][0-9.]*\' "$orca_real" 2>/dev/null | {',
  '            orca_symbols=0',
  '            while IFS= read -r orca_symbol; do',
  '              orca_symbols=$((orca_symbols + 1))',
  `              if [ "$orca_symbols" -gt ${MAX_SYMBOLS_PER_LIBRARY} ]; then`,
  `                printf '%s\n' '${PROBE_MARKER} SYMBOL_OVERFLOW'`,
  '                break',
  '              fi',
  '              printf \'%s\\n\' "$orca_symbol"',
  '            done',
  '          }',
  `          printf '%s\n' '${PROBE_MARKER} LIBRARY_END'`,
  '          ;;',
  '      esac',
  '    done',
  '  fi',
  'fi',
  `printf '%s\n' '${PROBE_MARKER} END'`
].join('\n')

function parseMarker(line: string): ProbeMarker | null {
  const fields = getProcessOutputFields(line, 3)
  if (fields.length !== 2 || fields[0] !== PROBE_MARKER) {
    return null
  }
  switch (fields[1]) {
    case 'BEGIN':
    case 'END':
    case 'LIBRARY_BEGIN':
    case 'LIBRARY_END':
      return fields[1]
    case 'LIBRARY_OVERFLOW':
    case 'SYMBOL_OVERFLOW':
      return 'INVALID'
    default:
      return null
  }
}

function parseVersion(value: string, minimumComponents: number): number[] | null {
  if (!/^\d+(?:\.\d+){1,2}$/.test(value)) {
    return null
  }
  const components = value.split('.').map(Number)
  return components.length >= minimumComponents && components.every(Number.isSafeInteger)
    ? components
    : null
}

function compareVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

function isSafeLibraryPath(value: string): boolean {
  if (
    value.length > MAX_LIBRARY_PATH_CHARS ||
    !/^\/[0-9A-Za-z_+./-]+$/.test(value) ||
    value.includes('//')
  ) {
    return false
  }
  return value.split('/').every((part) => part !== '.' && part !== '..')
}

function parseLibraryCandidate(lines: string[]): LibraryCandidate | null {
  if (lines.length < 3 || lines.length > MAX_SYMBOLS_PER_LIBRARY + 2) {
    return null
  }
  const path = lines[0].startsWith('path=') ? lines[0].slice('path='.length) : ''
  const file = lines[1].startsWith('file=') ? lines[1].slice('file='.length) : ''
  if (!isSafeLibraryPath(path) || path.slice(path.lastIndexOf('/') + 1) !== file) {
    return null
  }
  const fileMatch = /^libstdc\+\+\.so\.(\d+\.\d+\.\d+)$/.exec(file)
  if (!fileMatch || !parseVersion(fileMatch[1], 3)) {
    return null
  }

  let maximumSymbol: { version: string; components: number[] } | null = null
  for (const line of lines.slice(2)) {
    const symbolMatch = /^GLIBCXX_(\d+\.\d+(?:\.\d+)?)$/.exec(line)
    if (!symbolMatch) {
      return null
    }
    const components = parseVersion(symbolMatch[1], 2)
    if (!components) {
      return null
    }
    if (!maximumSymbol || compareVersions(components, maximumSymbol.components) > 0) {
      maximumSymbol = { version: symbolMatch[1], components }
    }
  }
  if (!maximumSymbol) {
    return null
  }
  return {
    path,
    libstdcxxVersion: fileMatch[1],
    glibcxxVersion: maximumSymbol.version
  }
}

function parseLibstdcxxEvidence(output: string): SshRelayLinuxLibstdcxxEvidence | undefined {
  let outerActive = false
  let outerComplete = false
  let libraryLines: string[] | null = null
  let invalid = false
  const candidates: LibraryCandidate[] = []

  for (const line of iterateProcessOutputLines(output)) {
    const marker = parseMarker(line)
    if (marker === 'BEGIN') {
      if (outerActive || outerComplete || libraryLines) {
        invalid = true
      }
      outerActive = true
      continue
    }
    if (marker === 'END') {
      if (!outerActive || outerComplete || libraryLines) {
        invalid = true
      }
      outerActive = false
      outerComplete = true
      continue
    }
    if (marker === 'LIBRARY_BEGIN') {
      if (!outerActive || libraryLines) {
        invalid = true
      }
      libraryLines = []
      continue
    }
    if (marker === 'LIBRARY_END') {
      if (!outerActive || !libraryLines) {
        invalid = true
        libraryLines = null
        continue
      }
      const candidate = parseLibraryCandidate(libraryLines)
      if (!candidate) {
        invalid = true
      } else {
        candidates.push(candidate)
      }
      libraryLines = null
      continue
    }
    if (marker === 'INVALID') {
      invalid = true
      continue
    }
    if (libraryLines) {
      if (libraryLines.length >= MAX_SYMBOLS_PER_LIBRARY + 2) {
        invalid = true
      } else {
        libraryLines.push(line)
      }
    } else if (outerActive) {
      invalid = true
    }
  }

  if (
    invalid ||
    outerActive ||
    !outerComplete ||
    libraryLines ||
    candidates.length === 0 ||
    candidates.length > MAX_LIBRARIES
  ) {
    return undefined
  }
  const paths = new Set(candidates.map((candidate) => candidate.path))
  const versions = new Set(
    candidates.map((candidate) => `${candidate.libstdcxxVersion}:${candidate.glibcxxVersion}`)
  )
  if (paths.size !== candidates.length || versions.size !== 1) {
    return undefined
  }
  return {
    libstdcxxVersion: candidates[0].libstdcxxVersion,
    glibcxxVersion: candidates[0].glibcxxVersion
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function detectSshRelayLinuxLibstdcxx(
  conn: SshConnection,
  { signal }: { signal?: AbortSignal } = {}
): Promise<SshRelayLinuxLibstdcxxEvidence | undefined> {
  try {
    const output = await execCommand(conn, PROBE_COMMAND, {
      signal,
      timeoutMs: PROBE_TIMEOUT_MS
    })
    return parseLibstdcxxEvidence(output)
  } catch (error) {
    // Why: cancellation must settle the caller's work instead of becoming compatibility evidence.
    if (isAbortError(error)) {
      throw error
    }
    return undefined
  }
}
