import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { runProcess, type ProcessResult, type ProcessSpec } from '../../shared/child-process/run-process'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { isUsablePtyTreeMarker, ORCA_PTY_TREE_ID_ENV } from '../pty/wsl-orca-env'

/**
 * Guest-side tree kill for WSL sessions.
 *
 * Why this exists: a WSL PTY's Windows side is `wsl.exe`, which the ConPTY
 * job terminates promptly — but the job never reaches the guest processes
 * inside the WSL2 VM, so `terminateOwnedTree` reporting `terminated` is no
 * evidence the agent's tool children died. The Windows fallback
 * (`taskkill /T /F`) cannot see them either. The only correct cleanup runs
 * inside the distro, keyed by the `ORCA_PTY_TREE_ID` marker every WSL spawn
 * stamps (inherited by all guest descendants through the environment).
 *
 * Best-effort by contract: never rejects. The Windows-side sweep always
 * runs afterwards regardless of the outcome here.
 */

export const WSL_GUEST_TREE_KILL_TIMEOUT_MS = 4_000
const WSL_GUEST_TREE_KILL_GRACE_SECONDS = 2

function buildGuestTreeKillScript(): string {
  return [
    // Why interpolated from the constant, not inlined: the guest script and
    // the spawn stamping must key the same variable, and a drifted literal
    // would silently match nothing.
    `_orca_tree_match="${ORCA_PTY_TREE_ID_ENV}=$1"`,
    '_orca_kill_marked() {',
    '  for _d in /proc/[0-9]*; do',
    '    _pid="${_d#/proc/}"',
    '    case "$_pid" in ""|*[!0-9]*) continue;; esac',
    '    [ "$_pid" = 1 ] && continue',
    '    [ "$_pid" = "$$" ] && continue',
    // Why tr plus fixed-string grep instead of ps/pkill: /proc is the one
    // interface every WSL distro has, and -F -x matches the marker line
    // byte-for-byte so a hostile argv cannot masquerade as membership.
    '    # shellcheck disable=SC2002',
    '    if tr "\\0" "\\n" < "$_d/environ" 2>/dev/null | grep -qxF -e "$_orca_tree_match"; then',
    '      kill "-$1" "$_pid" 2>/dev/null',
    '    fi',
    '  done',
    '}',
    '_orca_kill_marked TERM',
    `sleep ${WSL_GUEST_TREE_KILL_GRACE_SECONDS} || true`,
    '_orca_kill_marked KILL'
  ].join('\n')
}

/** argv for `wsl.exe -d <distro> --exec` that runs the guest tree kill. */
export function buildWslGuestTreeKillArgs(distro: string, treeId: string): string[] {
  // Why positional, not interpolated: the token never passes through a
  // shell on either side — execFile-style argv on Windows, $1 in the guest.
  return buildWslExecArgs(distro, ['sh', '-c', buildGuestTreeKillScript(), 'orca-wsl-tree-kill', treeId])
}

export type WslGuestTreeKillRunner = (spec: ProcessSpec) => Promise<ProcessResult>

/**
 * SIGTERM the marked guest tree, then SIGKILL survivors after the grace
 * window. Resolves in all cases — including off-platform, unusable markers,
 * spawn failures, and timeouts — so shutdown never depends on the guest.
 */
export async function runWslGuestTreeKill(deps: {
  distro: string | null | undefined
  treeId: string | undefined
  timeoutMs?: number
  run?: WslGuestTreeKillRunner
}): Promise<void> {
  if (process.platform !== 'win32') {
    return
  }
  if (!deps.distro || !isUsablePtyTreeMarker(deps.treeId)) {
    return
  }
  try {
    await (deps.run ?? runProcess)({
      program: 'wsl.exe',
      args: buildWslGuestTreeKillArgs(deps.distro, deps.treeId),
      timeoutMs: deps.timeoutMs ?? WSL_GUEST_TREE_KILL_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      cwd: resolveWslInteropSpawnCwd()
    })
  } catch {
    // Best-effort: the Windows-side sweep still runs.
  }
}
