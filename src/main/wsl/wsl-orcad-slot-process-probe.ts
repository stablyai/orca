/** Whether any process runs from an orcad slot: its server, or a terminal daemon a candidate spawned there, which outlives the candidate's stop. */
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { posixProcessArgsShellFunction } from '../managed-server/install/orcad-remote-host-support'
import { isOrcadInstallDirLive } from '../managed-server/install/orcad-remote-gc'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../ssh/remote-exec/remote-exec-command'
import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { OrcadSlotOptions } from '../ssh/orcad-recovery-slot'

// Every shell running this probe carries it in argv, so the probe never counts itself.
const PROBE_MARKER = '__ORCA_SLOT_PROCESS_PROBE__'

/** Prints LIVE, DEAD or UNKNOWN; anything unreadable is UNKNOWN. */
export function wslOrcadSlotProcessProbeCommand(
  host: RemoteHostPlatform,
  slotDir: string,
  userDataDir: string
): string {
  const slot = quotePosixShell(`${slotDir.replace(/\/+$/u, '')}/`)
  const daemonDir = quotePosixShell(joinRemotePath(host, userDataDir, 'daemon'))
  const inSlot =
    'grep -F -e "$orcad_slot" -e "$orcad_real/" | ' + `grep -vF -- ${PROBE_MARKER} | grep -q .`
  return [
    `orcad_slot=${slot}; orcad_ddir=${daemonDir}; : ${PROBE_MARKER};`,
    // Node realpaths its entry, so a daemon behind a symlinked home names the resolved slot.
    'orcad_real=$(cd "$orcad_slot" 2>/dev/null && pwd -P) && [ -n "$orcad_real" ] || { echo UNKNOWN; exit 0; };',
    posixProcessArgsShellFunction(),
    // A live daemon whose pid file names it must be identified, not skipped.
    'for orcad_df in "$orcad_ddir"/daemon-v*.pid; do [ -f "$orcad_df" ] || continue;',
    'orcad_dp=$(sed -n \'s/.*"pid":\\([0-9][0-9]*\\).*/\\1/p\' "$orcad_df" | head -n 1);',
    '[ -n "$orcad_dp" ] || continue; kill -0 "$orcad_dp" 2>/dev/null || continue;',
    'orcad_da=$(orcad_args "$orcad_dp") || { echo UNKNOWN; exit 0; };',
    `printf '%s\\n' "$orcad_da" | ${inSlot} && { echo LIVE; exit 0; };`,
    'done;',
    // Capture first so the filters below never list themselves.
    'if orcad_all=$(ps -ww -eo args= 2>/dev/null) && [ -n "$orcad_all" ]; then :;',
    'elif [ -r /proc/self/cmdline ]; then',
    'orcad_all=$(for orcad_p in /proc/[0-9]*; do tr "\\000" " " < "$orcad_p/cmdline" 2>/dev/null; echo; done);',
    'else echo UNKNOWN; exit 0; fi;',
    `if printf '%s\\n' "$orcad_all" | ${inSlot}; then echo LIVE; else echo DEAD; fi`
  ].join(' ')
}

/** True unless both the server's pid file and a process scan prove nothing runs from the slot. */
export async function isWslOrcadSlotInUse(
  slot: OrcadSlotOptions,
  slotDir: string
): Promise<boolean> {
  if (await isOrcadInstallDirLive(slot, slotDir)) {
    return true
  }
  try {
    const answer = await execCommand(
      slot.conn,
      wslOrcadSlotProcessProbeCommand(slot.host, slotDir, slot.userDataDir),
      { wrapCommand: true, signal: slot.signal }
    )
    return answer.trim().split('\n').at(-1)?.trim() !== 'DEAD'
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return true
  }
}
