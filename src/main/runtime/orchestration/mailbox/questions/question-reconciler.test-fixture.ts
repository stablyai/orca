import type { OrchestrationDb } from '../../db/orchestration-db'
import { QuestionReconciler, type QuestionReconcilerDeps } from './question-reconciler'

/** A reconciler whose parties are all at rest with no mail coming: each question it takes is told. */
export function startRestingQuestionReconciler(
  db: OrchestrationDb,
  notices: QuestionReconcilerDeps['notices']
): { reconciler: QuestionReconciler; stop: () => void } {
  const reconciler = new QuestionReconciler(db, {
    reads: {
      liveSession: (root) => root,
      chatRunning: async () => false,
      chatReceiving: () => null,
      chatHandingOver: () => false,
      terminal: () => null,
      terminalHandingOver: () => false
    },
    notices,
    sessionParty: (sessionId) => `session:${sessionId}`,
    terminalParty: () => null
  })
  return { reconciler, stop: reconciler.start() }
}
