import { quoteShell } from './cli-install-path-format'
import { buildServeUpdateHelperScript } from './serve-update-helper-script'

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
  const helperScript = buildServeUpdateHelperScript(input)
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "orca-serve-update-helper install must run as root" >&2
  exit 1
fi

# Root-owned helper, outside the service-user-writable spool dir.
mkdir -p /usr/lib/orca
cat > ${q(SERVE_UPDATE_HELPER_INSTALL_PATH)} <<'ORCA_HELPER_EOF'
${helperScript}
ORCA_HELPER_EOF
chown root:root ${q(SERVE_UPDATE_HELPER_INSTALL_PATH)}
chmod 0755 ${q(SERVE_UPDATE_HELPER_INSTALL_PATH)}

# Service user can run exactly the helper, no other command, no password.
# Why unquoted: sudoers is not a shell — quoting would change (or break) the rule.
cat > ${q(`${SERVE_UPDATE_SUDOERS_PATH}.new`)} <<ORCA_SUDOERS_EOF
${input.serviceUser} ALL=(root) NOPASSWD: ${SERVE_UPDATE_HELPER_INSTALL_PATH}
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
printf '{"helperVersion":1,"unitName":"%s"}' ${q(input.unitName)} > ${q(`${input.spoolDir}/helper.json`)}
chown root:root ${q(`${input.spoolDir}/helper.json`)}
chmod 0644 ${q(`${input.spoolDir}/helper.json`)}
echo "orca-serve-update-helper installed"
`
}
