import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { readUntrustedBoolean, readUntrustedString } from '../../shared/untrusted-value-fields'
import { buildWslGuestObservationPrelude } from './wsl-guest-filesystem-observation'
import { toWindowsWslPath } from '../wsl'
import {
  MARKER_NOT_REGULAR_FILE_MESSAGE,
  MISSING_MANAGED_HOME_MESSAGE,
  MISSING_OWNERSHIP_MARKER_MESSAGE,
  type HostCodexManagedHomeVerdict
} from './host-codex-managed-home-ownership'

/**
 * Why a tagged line instead of exit codes: under `set -e` an absent home, a
 * marker owned by another account, a `readlink` failure, and `wsl.exe` failing
 * to start a cold distro all abort with the same status and empty stdout, so no
 * exit code is observable evidence of *which* happened. The guest states its
 * observation and exits 0; only a parsed tag is dispositive, and everything else
 * — no tag, extra output, a throw from the runner, a timeout — is indeterminate.
 * That inverts the old default under which a cold distro read as "this home is
 * not Orca-owned" (STA-5616).
 */
const VERDICT_TAG = 'ORCA_CODEX_HOME_VERDICT:'

/** Any non-zero status is indeterminate; this one just names the intent. */
const PROBE_UNKNOWN_EXIT = 1

export const OUTSIDE_MANAGED_ROOT_MESSAGE =
  'Managed WSL Codex home is outside Orca account storage.'
export const ACCOUNT_ID_MISMATCH_MESSAGE =
  'Managed WSL Codex home does not match its persisted account ID.'
export const MARKER_ACCOUNT_MISMATCH_MESSAGE =
  'Managed WSL Codex home ownership marker does not match its account ID.'

/** What the host observed of the probe run itself, before any verdict parsing. */
export type WslCodexManagedHomeProbeOutcome =
  | { ran: true; stdout: string }
  | { ran: false; error: unknown }

/**
 * The canonical path is base64'd because it is interpolated into a
 * line-oriented protocol: a newline anywhere under `$HOME` would otherwise split
 * the verdict in two and read as a malformed probe.
 */
export function buildWslCodexManagedHomeProbeScript(
  linuxPath: string,
  expectedAccountId?: string
): string {
  return [
    'set -uo pipefail',
    ...buildWslGuestObservationPrelude(PROBE_UNKNOWN_EXIT),
    `tag() { printf '${VERDICT_TAG}%s\\n' "$1"; exit 0; }`,
    `candidate=${quotePosixShell(linuxPath)}`,
    'managed_root="${HOME%/}/.local/share/orca/codex-accounts"',
    'candidate_parent=$(dirname -- "$candidate") || unknown',
    'candidate_name=$(basename -- "$candidate") || unknown',
    // Absence is the only structural fact worth a tag here, and `kind_of` will
    // not report it without a listing that proves it.
    'kind_of "$candidate" "$candidate_parent" "$candidate_name"',
    'case "$KIND" in absent) tag missing-home ;; esac',
    'candidate_real=$(readlink -f -- "$candidate") || unknown',
    'managed_root_real=$(readlink -f -- "$managed_root") || unknown',
    'marker="$candidate_real/.orca-managed-home"',
    // One typed observation replaces the old -h/-e/-f chain, each link of which
    // was trusted in the negative and so could turn a stat failure into a
    // verdict. A symlink marker is not ownership proof (host-lane parity).
    'kind_of "$marker" "$candidate_real" .orca-managed-home',
    'case "$KIND" in',
    '  absent) tag missing-marker ;;',
    '  regular) ;;',
    '  *) tag marker-not-regular ;;',
    'esac',
    'contents=$(cat -- "$marker") || unknown',
    'case "$candidate_real" in "$managed_root_real"/*/home) ;; *) tag outside-managed-root ;; esac',
    ...(expectedAccountId === undefined
      ? ['case "$contents" in "") tag marker-mismatch ;; esac']
      : [
          `expected_marker=${quotePosixShell(expectedAccountId)}`,
          'if [ "$candidate_real" != "$managed_root_real/$expected_marker/home" ]; then tag account-mismatch; fi',
          'if [ "$contents" != "$expected_marker" ]; then tag marker-mismatch; fi'
        ]),
    "encoded=$(printf '%s' \"$candidate_real\" | base64 | tr -d '\\n') || unknown",
    'tag "owned:$encoded"'
  ].join('\n')
}

/** The one place that reads a raw field; kept local so nothing else dereferences the outcome. */
function readField(value: unknown, key: string): unknown {
  try {
    return value === null || typeof value !== 'object'
      ? undefined
      : (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function indeterminate(message: string, cause?: unknown): HostCodexManagedHomeVerdict {
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

const UNTRUSTED_TAGS = new Map<string, string>([
  ['missing-home', MISSING_MANAGED_HOME_MESSAGE],
  ['missing-marker', MISSING_OWNERSHIP_MARKER_MESSAGE],
  ['marker-not-regular', MARKER_NOT_REGULAR_FILE_MESSAGE],
  ['marker-mismatch', MARKER_ACCOUNT_MISMATCH_MESSAGE],
  ['account-mismatch', ACCOUNT_ID_MISMATCH_MESSAGE],
  ['outside-managed-root', OUTSIDE_MANAGED_ROOT_MESSAGE]
])

export function classifyWslCodexManagedHomeProbe(
  outcome: WslCodexManagedHomeProbeOutcome,
  distro: string
): HostCodexManagedHomeVerdict {
  // Why every field is read defensively: this value crosses a subprocess/IPC
  // boundary, so its runtime shape is not guaranteed by its type. A malformed
  // or hostile outcome must become indeterminate, not an untyped throw that no
  // caller can recognise as an unproven observation.
  const ran = readUntrustedBoolean(outcome, 'ran')
  if (ran !== true) {
    return {
      kind: 'indeterminate',
      error: new Error('WSL Codex ownership probe could not run.', {
        cause: ran === false ? readField(outcome, 'error') : outcome
      })
    }
  }
  const stdout = readUntrustedString(outcome, 'stdout')
  if (stdout === undefined) {
    return indeterminate('WSL Codex ownership probe returned no readable output.')
  }
  const lines = stdout
    .replaceAll(String.fromCharCode(0), '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const tagged = lines.filter((line) => line.startsWith(VERDICT_TAG))
  // The tag is the guest's last act, so anything after it means the run did not
  // end where the protocol says it ends.
  if (tagged.length !== 1 || lines.at(-1) !== tagged[0]) {
    return indeterminate('WSL Codex ownership probe did not report exactly one verdict.')
  }
  const value = tagged[0].slice(VERDICT_TAG.length)
  const untrustedReason = UNTRUSTED_TAGS.get(value)
  if (untrustedReason !== undefined) {
    return { kind: 'untrusted', reason: untrustedReason }
  }
  if (!value.startsWith('owned:')) {
    return indeterminate('WSL Codex ownership probe reported an unknown verdict.')
  }
  const canonicalPath = decodeCanonicalPath(value.slice('owned:'.length))
  return canonicalPath
    ? { kind: 'owned', homePath: toWindowsWslPath(canonicalPath, distro) }
    : indeterminate('WSL Codex ownership probe reported an undecodable path.')
}
