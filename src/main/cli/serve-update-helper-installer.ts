import { quoteShell } from './cli-install-path-format'
import { buildServeUpdateHelperScript } from './serve-update-helper-script'
import { SERVE_UPDATE_HELPER_VERSION } from '../../shared/serve-update-spool'

/** Root-owned install location, outside the service-user-writable spool dir. */
export const SERVE_UPDATE_HELPER_INSTALL_PATH = '/usr/lib/orca/serve-update-helper.sh'
export const SERVE_UPDATE_SUDOERS_PATH = '/etc/sudoers.d/orca-serve-update-helper'

export type ServeUpdateHelperInstallInput = {
  spoolDir: string
  unitName: string
  appImageTargetPath: string
  versionRecordPath: string
  /** The OS account the service runs as; sudoers and spool ownership use it. */
  serviceUser: string
}

/**
 * One-shot root setup script for the supervised serve update helper.
 *
 * Run with `sudo bash <script>`; the caller never interprets its output.
 * Idempotent: re-running rewrites the helper and re-validates the sudoers
 * drop-in, so an upgrade of the helper is the same operation as the install.
 *
 * Trust model: the helper lives root-owned outside the spool dir (the service
 * user can write spool files but never the helper), and the sudoers rule is
 * validated with `visudo -cf` before publication — a bad drop-in aborts the
 * whole install rather than risking a locked-out sudoers directory.
 */
export function buildServeUpdateHelperInstallScript(input: ServeUpdateHelperInstallInput): string {
  const q = quoteShell
  // Why: sudoers is not a shell and has no safe quoting for `'`; a service account name
  // that could break the rule is refused rather than escaped.
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(input.serviceUser)) {
    throw new Error(`invalid service user name: ${input.serviceUser}`)
  }
  // Why: the helper is embedded in a heredoc; a newline in a flag value could terminate
  // it early and execute trailing text as root at install time. quoteShell does not
  // encode newlines, so anything carrying one is refused instead of escaped.
  for (const [name, value] of Object.entries(input)) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`${name} must not contain newlines`)
    }
  }
  const helperScript = buildServeUpdateHelperScript(input)
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "orca-serve-update-helper install must run as root" >&2
  exit 1
fi

# The helper treats jq and flock as hard dependencies; without jq the helper.json
# below would be written malformed and the reader would silently disable the
# feature. Refuse to publish a half-working install.
if ! command -v jq >/dev/null 2>&1; then
  echo "orca-serve-update-helper install requires jq (the helper cannot write verdicts without it)" >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "orca-serve-update-helper install requires flock (the helper cannot serialize updates without it)" >&2
  exit 1
fi

# Root-owned helper, outside the service-user-writable spool dir.
mkdir -p /usr/lib/orca
cat > ${q(SERVE_UPDATE_HELPER_INSTALL_PATH)} <<'ORCA_HELPER_EOF'
${helperScript}
ORCA_HELPER_EOF
chown root:root ${q(SERVE_UPDATE_HELPER_INSTALL_PATH)}
chmod 0755 ${q(SERVE_UPDATE_HELPER_INSTALL_PATH)}

# Service user can run exactly the helper, no other command, no arguments, no password.
# Why unquoted: sudoers is not a shell — quoting would change (or break) the rule.
# Why the "" argument spec: without it sudo permits arbitrary argv; the helper takes none.
cat > ${q(`${SERVE_UPDATE_SUDOERS_PATH}.new`)} <<ORCA_SUDOERS_EOF
${input.serviceUser} ALL=(root) NOPASSWD: ${SERVE_UPDATE_HELPER_INSTALL_PATH} ""
ORCA_SUDOERS_EOF
chown root:root ${q(`${SERVE_UPDATE_SUDOERS_PATH}.new`)}
chmod 0440 ${q(`${SERVE_UPDATE_SUDOERS_PATH}.new`)}
if ! visudo -cf ${q(`${SERVE_UPDATE_SUDOERS_PATH}.new`)}; then
  rm -f ${q(`${SERVE_UPDATE_SUDOERS_PATH}.new`)}
  echo "orca-serve-update-helper sudoers drop-in failed validation" >&2
  exit 1
fi
mv -f ${q(`${SERVE_UPDATE_SUDOERS_PATH}.new`)} ${q(SERVE_UPDATE_SUDOERS_PATH)}

# Spool dir is writable by the service user; the app spools requests and the
# root helper writes verdicts. helper.json names the unit and helper version.
mkdir -p ${q(input.spoolDir)}
chown root:${q(input.serviceUser)} ${q(input.spoolDir)}
chmod 0775 ${q(input.spoolDir)}
# unitName is JSON-encoded via jq -Rs (not shell-quoted): a quote or backslash in
# --unit must not produce a helper.json that fails to parse, because the reader
# treats a malformed marker as "helper absent" and disables the feature.
# Why mktemp+mv and not a bare redirect: the spool dir is service-user-writable, so
# on a re-install a pre-planted helper.json symlink would otherwise be truncated
# as root at the redirect target.
helper_json_tmp=$(mktemp ${q(input.spoolDir)}/helper.json.XXXXXXXX)
printf '{"helperVersion":${SERVE_UPDATE_HELPER_VERSION},"unitName":%s}' "$(printf '%s' ${q(input.unitName)} | jq -Rs .)" > "$helper_json_tmp"
chown root:root "$helper_json_tmp"
chmod 0644 "$helper_json_tmp"
mv -f "$helper_json_tmp" ${q(`${input.spoolDir}/helper.json`)}
echo "orca-serve-update-helper installed"
`
}
