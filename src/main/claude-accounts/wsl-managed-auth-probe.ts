import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { toWindowsWslPath } from '../wsl'
import { runWslProcess, type WslResult } from '../wsl/wsl-runner'
import {
  MISSING_MANAGED_AUTH_MESSAGE,
  OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE,
  UNTRUSTED_MANAGED_AUTH_MESSAGE,
  type ClaudeManagedAuthVerdict
} from './claude-managed-auth-ownership'
import { MANAGED_AUTH_MARKER, readManagedAuthMarkerState } from './managed-auth-path'

const MANAGED_GUEST_ROOT_SEGMENT = '/.local/share/orca/claude-accounts/'

/**
 * Why a tagged line instead of exit codes: under `set -e` a missing marker, a
 * marker for another account, a `readlink` failure, and `wsl.exe` failing to
 * start the distro all abort with the same status and empty stdout, so no exit
 * code is observable evidence of *which* happened. The guest instead states its
 * observation and exits 0; only a parsed tag is dispositive, and everything
 * else — no tag, extra output, non-zero exit, timeout, spawn failure — is
 * indeterminate. That inverts the old default under which a cold distro read as
 * "this is not your auth directory" (STA-5674).
 */
const VERDICT_TAG = 'ORCA_CLAUDE_AUTH_VERDICT:'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * The canonical path is base64'd because it is interpolated into a line-oriented
 * protocol: a newline anywhere in `$HOME` would otherwise split the verdict in
 * two and read as a malformed probe.
 */
export function buildWslManagedAuthProbeScript(
  linuxPath: string,
  expectedAccountId?: string
): string {
  const markerTest = expectedAccountId
    ? `test "$contents" = ${shellQuote(expectedAccountId)}`
    : 'test -n "$contents"'
  return [
    'set -uo pipefail',
    `tag() { printf '${VERDICT_TAG}%s\\n' "$1"; exit 0; }`,
    `candidate=${shellQuote(linuxPath)}`,
    'managed_root="${HOME%/}/.local/share/orca/claude-accounts"',
    'test -h "$candidate" && tag candidate-is-symlink',
    'candidate_real=$(readlink -f -- "$candidate") || exit 1',
    'managed_root_real=$(readlink -f -- "$managed_root") || exit 1',
    // A directory we cannot search reports "no such marker" exactly as an empty
    // one does, so prove we can look before believing anything we did not find.
    // (`readlink -f` above tolerates a missing trailing component on GNU but not
    // on BSD/BusyBox; there an absent directory exits 1, which is a refusal too.)
    'if test ! -d "$candidate_real"; then',
    '  test -e "$candidate_real" && tag not-a-directory',
    '  parent=$(dirname -- "$candidate_real") || exit 1',
    '  test -d "$parent" && test -r "$parent" && test -x "$parent" || exit 1',
    '  tag missing-directory',
    'fi',
    'test -r "$candidate_real" && test -x "$candidate_real" || exit 1',
    'marker="$candidate_real/.orca-managed-claude-auth"',
    'test -h "$marker" && tag marker-is-symlink',
    'if test ! -f "$marker"; then',
    '  test -e "$marker" && tag marker-not-a-file',
    '  tag missing-marker',
    'fi',
    'contents=$(cat -- "$marker") || exit 1',
    `${markerTest} || tag marker-mismatch`,
    // A shell `*` matches `/` too, so `<root>/*/auth` also matched
    // `<root>/other/acct/auth`. Strip the root and require exactly one segment
    // before `auth`.
    'rest=${candidate_real#"$managed_root_real"/}',
    'test "$rest" != "$candidate_real" || tag outside-managed-root',
    'account_segment=${rest%/auth}',
    'test "$account_segment" != "$rest" || tag outside-managed-root',
    'case "$account_segment" in \'\'|*/*) tag outside-managed-root ;; esac',
    "encoded=$(printf '%s' \"$candidate_real\" | base64 | tr -d '\\n') || exit 1",
    'tag "owned:$encoded"'
  ].join('\n')
}

/**
 * Every tag the guest emits after an observation it completed. A tag absent from
 * this table is not a default — an unknown verdict is indeterminate, because it
 * means the guest and this parser disagree about the protocol.
 */
const DISPOSITIVE_TAGS: Record<string, string | undefined> = {
  'missing-directory': MISSING_MANAGED_AUTH_MESSAGE,
  'missing-marker': MISSING_MANAGED_AUTH_MESSAGE,
  'marker-mismatch': UNTRUSTED_MANAGED_AUTH_MESSAGE,
  'marker-not-a-file': UNTRUSTED_MANAGED_AUTH_MESSAGE,
  'marker-is-symlink': UNTRUSTED_MANAGED_AUTH_MESSAGE,
  'candidate-is-symlink': UNTRUSTED_MANAGED_AUTH_MESSAGE,
  'not-a-directory': UNTRUSTED_MANAGED_AUTH_MESSAGE,
  'outside-managed-root': OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE
}

function indeterminate(message: string, cause?: unknown): ClaudeManagedAuthVerdict {
  return { kind: 'indeterminate', error: new Error(message, cause ? { cause } : undefined) }
}

/** Base64 round-trips so a truncated or garbled payload cannot become a path. */
function decodeCanonicalPath(encoded: string): string | null {
  if (!encoded) {
    return null
  }
  const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
  return decoded && Buffer.from(decoded, 'utf-8').toString('base64') === encoded ? decoded : null
}

export function classifyWslManagedAuthProbe(
  probe: WslResult,
  distro: string
): ClaudeManagedAuthVerdict {
  if (probe.timedOut) {
    return indeterminate('WSL Claude ownership probe timed out.')
  }
  if (!probe.environmentResolved) {
    return indeterminate('WSL Claude ownership probe could not resolve the distro environment.')
  }
  if (probe.code !== 0) {
    return indeterminate(`WSL Claude ownership probe exited with code ${String(probe.code)}.`)
  }
  const lines = probe.stdout
    .replaceAll(String.fromCharCode(0), '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const tagged = lines.filter((line) => line.startsWith(VERDICT_TAG))
  // The tag is the guest's last act, so anything after it means the run did not
  // end where the protocol says it ends.
  if (tagged.length !== 1 || lines.at(-1) !== tagged[0]) {
    return indeterminate('WSL Claude ownership probe did not report exactly one verdict.')
  }
  const value = tagged[0].slice(VERDICT_TAG.length)
  const untrustedReason = DISPOSITIVE_TAGS[value]
  if (untrustedReason !== undefined) {
    return { kind: 'untrusted', reason: untrustedReason }
  }
  if (!value.startsWith('owned:')) {
    return indeterminate('WSL Claude ownership probe reported an unknown verdict.')
  }
  const canonicalPath = decodeCanonicalPath(value.slice('owned:'.length))
  return canonicalPath
    ? { kind: 'owned', authPath: toWindowsWslPath(canonicalPath, distro) }
    : indeterminate('WSL Claude ownership probe reported an undecodable path.')
}

/**
 * The one place a WSL-spelled managed auth path is judged, shared by the storage
 * gate and the runtime-auth sync so the two lanes cannot drift apart on what a
 * failed probe means (STA-5674).
 */
export async function resolveWslManagedAuthVerdict(
  candidatePath: string,
  wslInfo: { distro: string; linuxPath: string },
  expectedAccountId?: string
): Promise<ClaudeManagedAuthVerdict> {
  if (!hasManagedGuestPathShape(wslInfo.linuxPath, expectedAccountId)) {
    return { kind: 'untrusted', reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE }
  }
  if (process.platform !== 'win32') {
    return resolveHostVisibleGuestVerdict(candidatePath, expectedAccountId)
  }
  let probe: WslResult
  try {
    probe = await runWslProcess({
      distro: wslInfo.distro,
      loginPath: 'none',
      shell: 'bash',
      script: buildWslManagedAuthProbeScript(wslInfo.linuxPath, expectedAccountId),
      timeoutMs: 5000
    })
  } catch (error) {
    // A spawn failure says nothing about the directory; it says wsl.exe did not run.
    return { kind: 'indeterminate', error }
  }
  return classifyWslManagedAuthProbe(probe, wslInfo.distro)
}

/**
 * Orca only ever creates `<root>/<accountId>/auth`, so anything with extra
 * components between the root and `auth` is not that directory however much of
 * the suffix it shares. A suffix test accepted `<root>/other/acct/auth` as
 * account `acct`.
 */
function hasManagedGuestPathShape(linuxPath: string, expectedAccountId?: string): boolean {
  const rootIndex = linuxPath.indexOf(MANAGED_GUEST_ROOT_SEGMENT)
  if (rootIndex === -1) {
    return false
  }
  const segments = linuxPath.slice(rootIndex + MANAGED_GUEST_ROOT_SEGMENT.length).split('/')
  if (segments.length !== 2 || segments[0].length === 0 || segments[1] !== 'auth') {
    return false
  }
  return expectedAccountId === undefined || segments[0] === expectedAccountId
}

/**
 * A guest path the host can address directly (a non-win32 host holding a
 * WSL-spelled record). Held to the same bar as the guest probe: a symlinked
 * candidate or marker, and a marker naming another account, are all refusals.
 */
function resolveHostVisibleGuestVerdict(
  candidatePath: string,
  expectedAccountId?: string
): ClaudeManagedAuthVerdict {
  let candidateStats: ReturnType<typeof lstatSync>
  try {
    candidateStats = lstatSync(candidatePath)
  } catch (error) {
    return isDefinitiveAbsence(error)
      ? { kind: 'untrusted', reason: MISSING_MANAGED_AUTH_MESSAGE }
      : { kind: 'indeterminate', error }
  }
  if (candidateStats.isSymbolicLink() || !candidateStats.isDirectory()) {
    return { kind: 'untrusted', reason: UNTRUSTED_MANAGED_AUTH_MESSAGE }
  }
  const marker = readManagedAuthMarkerState(
    join(candidatePath, MANAGED_AUTH_MARKER),
    expectedAccountId
  )
  if (marker.kind === 'indeterminate') {
    return marker
  }
  return marker.kind === 'valid'
    ? { kind: 'owned', authPath: candidatePath }
    : { kind: 'untrusted', reason: UNTRUSTED_MANAGED_AUTH_MESSAGE }
}
