import type { CliInstallStatus } from '../../shared/cli-install-types'
import {
  buildManagedLegacyRemoveCommand,
  buildRegistrationLockPrelude,
  buildSafeReplaceGuard,
  buildWslBridgeScript,
  buildWslLauncher,
  getBridgePathFromCommandPath,
  getPosixDirname,
  getWslBridgeMarker,
  getWslLauncherMarker
} from './wsl-cli-scripts'
import { quotePosixShellDoubleQuotedApostrophe } from '../../shared/shell-argument-quoting'

const MANAGED_MARKER = getWslLauncherMarker()
const BRIDGE_MANAGED_MARKER = getWslBridgeMarker()
const LEGACY_WSL_COMMAND_NAME = 'orca'

export function buildWslCliInstallCommand(
  status: CliInstallStatus & { commandPath: string; launcherPath: string }
): string {
  const bridgePath = getBridgePathFromCommandPath(status.commandPath)
  const commandDirectory = getPosixDirname(status.commandPath)
  const legacyCommandPath = `${commandDirectory}/${LEGACY_WSL_COMMAND_NAME}`
  return [
    // Runs under sh; Ubuntu 20.04 dash lacks pipefail, and no pipeline here needs it.
    'set -eu',
    `mkdir -p ${quotePosixShellDoubleQuotedApostrophe(commandDirectory)}`,
    `mkdir -p ${quotePosixShellDoubleQuotedApostrophe(getPosixDirname(bridgePath))}`,
    buildRegistrationLockPrelude(status.commandPath),
    `command_tmp=${quotePosixShellDoubleQuotedApostrophe(`${status.commandPath}.tmp`)}.$$`,
    `bridge_path=${quotePosixShellDoubleQuotedApostrophe(bridgePath)}`,
    `legacy_command_path=${quotePosixShellDoubleQuotedApostrophe(legacyCommandPath)}`,
    'bridge_tmp="${bridge_path}.tmp.$$"',
    'bridge_backup="${bridge_tmp}.backup"',
    'bridge_had_original=0',
    'bridge_touched=0',
    'committed=0',
    'rollback() {',
    '  result=$?',
    '  set +e',
    '  if [ "$committed" -ne 1 ]; then',
    `    if [ "$bridge_had_original" -eq 1 ]; then mv -f "$bridge_backup" ${quotePosixShellDoubleQuotedApostrophe(bridgePath)}; elif [ "$bridge_touched" -eq 1 ]; then rm -f ${quotePosixShellDoubleQuotedApostrophe(bridgePath)}; fi`,
    '  fi',
    '  rm -f "$command_tmp" "$bridge_tmp" "$bridge_backup"',
    '  exit "$result"',
    '}',
    'trap rollback EXIT',
    buildSafeReplaceGuard(status.commandPath, MANAGED_MARKER),
    buildSafeReplaceGuard(bridgePath, BRIDGE_MANAGED_MARKER),
    `cat > "$command_tmp" <<'ORCA_WSL_CLI'`,
    buildWslLauncher(status.launcherPath, bridgePath),
    'ORCA_WSL_CLI',
    `cat > "$bridge_tmp" <<'ORCA_WSL_BRIDGE'`,
    buildWslBridgeScript(),
    'ORCA_WSL_BRIDGE',
    'chmod 755 "$command_tmp"',
    'chmod 644 "$bridge_tmp"',
    buildSafeReplaceGuard(status.commandPath, MANAGED_MARKER),
    buildSafeReplaceGuard(bridgePath, BRIDGE_MANAGED_MARKER),
    `if [ -f ${quotePosixShellDoubleQuotedApostrophe(bridgePath)} ]; then cp -p ${quotePosixShellDoubleQuotedApostrophe(bridgePath)} "$bridge_backup"; bridge_had_original=1; fi`,
    `mv -f "$bridge_tmp" ${quotePosixShellDoubleQuotedApostrophe(bridgePath)}`,
    'bridge_touched=1',
    `mv -f "$command_tmp" ${quotePosixShellDoubleQuotedApostrophe(status.commandPath)}`,
    'committed=1',
    'rm -f "$bridge_backup"',
    buildManagedLegacyRemoveCommand('"$legacy_command_path"'),
    'trap - EXIT'
  ].join('\n')
}
