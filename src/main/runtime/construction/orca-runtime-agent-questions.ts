// The runtime layer that decides when an agent question's asker is told its taker stopped without
// answering: it reads each party's chat, terminal and deliveries for the question reconciler.
import { OrcaRuntimeWithAgentTransitions } from './orca-runtime-agent-transitions'
import { OrcaRuntimeWithSidebarTemporal } from '../sidebar-inputs/orca-runtime-sidebar-temporal'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-list/feed/sidebar-inputs-switch'
import type { OrchestrationDb } from '../orchestration/db/orchestration-db'
import {
  installQuestionReconciler,
  type QuestionReconcilerInstall
} from '../orchestration/mailbox/questions/question-reconciler-install'
import type { QuestionReconciler } from '../orchestration/mailbox/questions/question-reconciler'
import {
  liveLineageSession,
  type QuestionPartyReads
} from '../orchestration/mailbox/questions/question-party-facts'
import { mailTakerKey, sessionMailTaker } from '../orchestration/db/messages/mail-taker'
import { isMailboxTerminalTakingInput } from '../orchestration/mailbox/routing/mailbox-owner'

const OrcaRuntimeSidebarBase: typeof OrcaRuntimeWithAgentTransitions = ORCA_SIDEBAR_INPUTS_IS_MAIN
  ? OrcaRuntimeWithSidebarTemporal
  : OrcaRuntimeWithAgentTransitions

export abstract class OrcaRuntimeWithAgentQuestions extends OrcaRuntimeSidebarBase {
  /** Decides when an agent question's asker is told its taker stopped without answering. */
  questionReconciler: QuestionReconciler | null = null
  private stopQuestionReconciler: (() => void) | undefined

  protected startQuestionReconciler(
    db: OrchestrationDb,
    notices: QuestionReconcilerInstall['notices']
  ): void {
    this.stopQuestionReconciler?.()
    const installed = installQuestionReconciler(db, {
      reads: this.questionPartyReads(),
      notices,
      sessionParty: (sessionId) => mailTakerKey(sessionMailTaker(sessionId)),
      terminalOfPty: (ptyId) => this.getOrchestrationMailboxTerminal(ptyId)?.handle ?? null,
      terminalOfPane: (paneKey) => this.getTerminalHandleForPaneKey(paneKey),
      subscribePanes: (listener) => this.agentTransitions.subscribe(listener)
    })
    this.questionReconciler = installed.reconciler
    this.stopQuestionReconciler = installed.stop
  }

  private questionPartyReads(): Omit<QuestionPartyReads, 'chatRunning'> {
    const structured = this.orchestrationStructuredMailboxPointerDelivery
    return {
      liveSession: liveLineageSession,
      chatReceiving: (mailbox) => structured.receiving(mailbox),
      chatHandingOver: (mailbox) => structured.handingOver(mailbox),
      terminal: (handle) => {
        const terminal = this.getOrchestrationMailboxTerminalForHandle(handle)
        return terminal
          ? {
              ptyId: terminal.ptyId,
              paneKeys: terminal.paneKeys,
              asking: this.isPtyAwaitingUserInput(terminal.ptyId),
              takesInput: isMailboxTerminalTakingInput(terminal),
              working: terminal.paneKeys.some(
                (paneKey) => this.agentTransitions.phaseOf(paneKey) === 'working'
              )
            }
          : null
      },
      terminalHandingOver: (ptyId) => this.orchestrationMailboxPointerDelivery.handingOver(ptyId)
    }
  }
}
