import { OrcaRuntimeWithPluginHookedTerminalInput } from './terminal-plugin-hooked-input'
import { readHermesChatActivity } from '../../../native-chat/terminal-chat-activity'

export abstract class OrcaRuntimeWithTerminalChatActivity extends OrcaRuntimeWithPluginHookedTerminalInput {
  getHermesChatActivity(handle: string) {
    const ptyId = this.terminalAgentStatus.getPtyId(handle)
    const pty = this.ptysById.get(ptyId)
    return readHermesChatActivity({
      agent: this.getPaneAgentForTuiIdle(ptyId),
      title: this.ptyTitleTrackersByPtyId.get(ptyId)?.lastTitle?.raw ?? pty?.lastOscTitle ?? null,
      programActivity: this.ptyTitleTrackersByPtyId.get(ptyId)?.programActivity,
      titleObservedAt: pty?.lastOscTitleEpochMs ?? null,
      observedLive: pty?.lastAgentStatusObservedLive === true,
      lastInputAt: this.terminalRunFacts.readLastInputAt(ptyId),
      workingSequence: this.agentPromptLifecycleByPtyId.get(ptyId)?.workingSequence ?? 0,
      screen: this.readCaughtUpRuledScreen(ptyId)
    })
  }
}
