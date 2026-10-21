import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'

import type { GuestTreeKillArtifact } from '../../shared/guest-tree-kill-artifacts'
export type WslGuestTreeKillArtifacts = {
  x64: GuestTreeKillArtifact
  arm64: GuestTreeKillArtifact
}

// Decode only host-verified bytes into a private copy; no guest-writable source path is executed.
const GUEST_TREE_KILL_BOOTSTRAP = [
  'set -eu',
  'IFS= read -r _orca_x64 || exit 3',
  'IFS= read -r _orca_arm64 || exit 3',
  'case "$(uname -m)" in',
  '  x86_64) _orca_payload=$_orca_x64; _orca_hash=$1 ;;',
  '  aarch64|arm64) _orca_payload=$_orca_arm64; _orca_hash=$2 ;;',
  '  *) exit 3 ;;',
  'esac',
  'unset _orca_x64 _orca_arm64',
  'umask 077',
  '_orca_tmp=$(mktemp -d /tmp/orca-guest-kill.XXXXXXXXXX) || exit 3',
  'trap \'rm -f "$_orca_tmp/helper"; rmdir "$_orca_tmp"\' 0',
  "trap 'exit 2' HUP INT TERM",
  'printf %s "$_orca_payload" | base64 -d > "$_orca_tmp/helper" || exit 3',
  'unset _orca_payload',
  '_orca_actual=$(sha256sum "$_orca_tmp/helper") || exit 3',
  '_orca_actual=${_orca_actual%% *}',
  '[ "$_orca_actual" = "$_orca_hash" ] || exit 3',
  'chmod 700 "$_orca_tmp/helper" || exit 3',
  // Keep the shell for its EXIT trap; exec would abandon the temporary directory.
  'set +e',
  '"$_orca_tmp/helper" "$3" "$4"',
  '_orca_status=$?',
  'exit "$_orca_status"'
].join('\n')

/** Runs only a hash-verified private copy, under an empty guest environment. */
export function buildWslGuestTreeKillArgs(
  distro: string,
  treeId: string,
  artifacts: WslGuestTreeKillArtifacts,
  guestBudgetMs: number
): string[] {
  return [
    '--user',
    'root',
    ...buildWslExecArgs(distro, [
      '/usr/bin/env',
      '-i',
      'PATH=/usr/bin:/bin',
      'LC_ALL=C',
      '/bin/sh',
      '-c',
      GUEST_TREE_KILL_BOOTSTRAP,
      'orca-wsl-tree-kill',
      artifacts.x64.sha256,
      artifacts.arm64.sha256,
      treeId,
      String(Math.min(3_000, guestBudgetMs))
    ])
  ]
}

/** Two bounded base64 lines keep the bootstrap independent of guest mount paths. */
export function buildWslGuestTreeKillInput(artifacts: WslGuestTreeKillArtifacts): string {
  return `${artifacts.x64.bytes.toString('base64')}\n${artifacts.arm64.bytes.toString('base64')}\n`
}
