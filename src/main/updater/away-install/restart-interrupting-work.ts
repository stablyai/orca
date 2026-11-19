import { hasLiveNativeChatTurns } from '../../native-chat/agent-session-wire/host/structured-agent-session-live-turns'
import { ptyProcesses } from '../../providers/local-pty/local-pty-provider-state'
import { hasActiveCoordinatorRun } from '../../runtime/rpc/methods/orchestration/gates/gates'
import { hasOpenPlainSshTerminals } from '../../ssh/plain-ssh-terminal/plain-ssh-terminal-sessions'
import { wslMoveInstallHold } from '../lifecycle/updater-wsl-move-install-hold'

export function findRestartInterruptingWork(): string | null {
  if (ptyProcesses.size > 0) {
    return 'in-process-terminal'
  }
  if (hasLiveNativeChatTurns()) {
    return 'native-chat-turn'
  }
  if (hasActiveCoordinatorRun()) {
    return 'orchestration-run'
  }
  if (hasOpenPlainSshTerminals()) {
    return 'plain-ssh-terminal'
  }
  return wslMoveInstallHold() !== null ? 'wsl-move' : null
}
