import {
  bindJcodeDisplaySession,
  clearJcodeDisplayBindingsOfRoot,
  closeJcodeSessionTab,
  confirmJcodeSessionTab,
  findJcodeSessionOwner,
  jcodeDisplayPanesOfRoot,
  jcodePaneRetirementState,
  releaseJcodeSessionTab,
  reserveJcodeSessionTab,
  settleJcodeDisplayPane,
  type JcodeDisplayBinding,
  type JcodeTabOwner
} from '../../../shared/agent-hook-listener/jcode-display-registry'
import { AgentHookServerState } from './server-state'

export abstract class AgentHookServerJcodeTabs extends AgentHookServerState {
  rootJcodeSessionId(paneKey: string): string | undefined {
    return this.state.jcodeSessions.roots.get(paneKey)
  }

  findJcodeSessionOwner(sessionId: string) {
    return findJcodeSessionOwner(this.state, sessionId)
  }

  reserveJcodeSessionTab(owner: Omit<JcodeTabOwner, 'state'>) {
    return reserveJcodeSessionTab(this.state, owner)
  }

  confirmJcodeSessionTab(sessionId: string, paneKey: string): boolean {
    return confirmJcodeSessionTab(this.state, sessionId, paneKey)
  }

  releaseJcodeSessionTab(sessionId: string, paneKey: string): void {
    releaseJcodeSessionTab(this.state, sessionId, paneKey)
  }

  bindJcodeDisplaySession(binding: JcodeDisplayBinding): boolean {
    return bindJcodeDisplaySession(this.state, binding)
  }

  settleJcodeDisplayPane(displayPaneKey: string): boolean {
    return settleJcodeDisplayPane(this.state, displayPaneKey)
  }

  jcodeDisplayPanesOfRoot(rootPaneKey: string): string[] {
    return jcodeDisplayPanesOfRoot(this.state, rootPaneKey)
  }

  jcodePaneRetirementState(paneKey: string) {
    return jcodePaneRetirementState(this.state, paneKey)
  }

  clearJcodeDisplayBindingsOfRoot(rootPaneKey: string): void {
    clearJcodeDisplayBindingsOfRoot(this.state, rootPaneKey)
  }

  closeJcodeSessionTab(paneKey: string): string[] {
    return closeJcodeSessionTab(this.state, paneKey)
  }
}
