// Starts the agent-question reconciler when the orchestration database opens: it follows each
// installed chat host's status observations and every terminal agent's phase changes.
import type { OrchestrationDb } from '../../db/orchestration-db'
import { QuestionReconciler, type QuestionReconcilerDeps } from './question-reconciler'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionHostChanged
} from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { AgentPaneChange } from '../../../../agent-hooks/observations/agent-transition-detector'
import type { QuestionPartyReads } from './question-party-facts'
import {
  chatTurnRunning,
  type ChatStateReader
} from '../../../../native-chat/agent-session-wire/observations/chat-turn-running'

export type QuestionReconcilerInstall = Omit<
  QuestionReconcilerDeps,
  'terminalParty' | 'reads' | 'notices'
> & {
  reads: Omit<QuestionPartyReads, 'chatRunning'>
  /** As the reconciler's, with the chat status reader for the notice's wording. */
  notices(
    taker: string,
    messageIds: readonly string[],
    readChat: ChatStateReader
  ): ReturnType<QuestionReconcilerDeps['notices']>
  terminalOfPty(ptyId: string): string | null
  terminalOfPane(paneKey: string): string | null
  subscribePanes(listener: (change: AgentPaneChange) => void): () => void
}

export function installQuestionReconciler(
  db: OrchestrationDb,
  install: QuestionReconcilerInstall
): { reconciler: QuestionReconciler; stop: () => void } {
  const terminalParty = (handle: string | null) => (handle ? `terminal:${handle}` : null)
  let readChat: ChatStateReader | null = null
  const readChatNow: ChatStateReader = async (sessionId) => (await readChat?.(sessionId)) ?? null
  const reconciler = new QuestionReconciler(db, {
    ...install,
    notices: (taker, messageIds) => install.notices(taker, messageIds, readChatNow),
    reads: {
      ...install.reads,
      // The chat's journal now, never its last event: a take can commit just before its turn shows.
      chatRunning: async (sessionId) => {
        const state = await readChatNow(sessionId)
        return state ? chatTurnRunning(state) : null
      }
    },
    terminalParty: (ptyId) => terminalParty(install.terminalOfPty(ptyId))
  })
  const followChats = () => {
    readChat = null
    return getStructuredAgentSessionHost()?.subscribeTurnCompletions({
      id: 'agent-question-reconciler',
      emit: () => undefined,
      readsState: (read) => (readChat = read),
      onObserved: (sessionId, running) => reconciler.chatObserved(sessionId, running),
      onClosed: (sessionId) => reconciler.chatObserved(sessionId, false)
    })
  }
  let stopChats = followChats()
  const stopHost = onStructuredAgentSessionHostChanged(() => {
    stopChats?.()
    stopChats = followChats()
    // A new host reads the chats and sender records an earlier decision couldn't.
    reconciler.decideAll()
  })
  const stopPanes = install.subscribePanes((change) => {
    const phase = change.kind === 'moved' ? change.to : change.phase
    if (phase !== 'working' && reconciler.watching()) {
      reconciler.terminalChanged(terminalParty(install.terminalOfPane(change.paneKey)), false)
    }
  })
  const stopEdges = reconciler.start()
  return {
    reconciler,
    stop: () => {
      stopEdges()
      stopPanes()
      stopHost()
      stopChats?.()
    }
  }
}
