import { z } from 'zod'
import { isInBotHome } from '../../../../../../bots/bot-home-membership'
import {
  sessionCallerOf,
  type OrchestrationEntryCaller
} from '../../../../../orchestration/addressing/orchestration-caller-identity'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import { resolveDispatchCreator } from '../../runs/dispatch-creator'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from '../../structured-workers/orchestration-worker-start-mode'

/** Workers started from a persistent agent's home, and every worker under them at any depth, start
 *  as chats: the home's own chats start the lineage, and each worker passes its Dispatch's stamp on. */
export function startsInChatLineage(
  runtime: Pick<OrcaRuntimeService, 'bots'> & Parameters<typeof resolveDispatchCreator>[0],
  db: OrchestrationDb,
  params: { from?: string; retryOf?: string },
  caller: OrchestrationEntryCaller | undefined,
  followUpOf?: string
): boolean {
  if (isInBotHome(runtime.bots, sessionCallerOf(caller))) {
    return true
  }
  // A retry or follow-up continues the worker it repeats, whoever sends it.
  const earlier = [params.retryOf, followUpOf].filter((id): id is string => Boolean(id))
  if (earlier.some((id) => db.getDispatchContextById(id)?.chat_lineage === 1)) {
    return true
  }
  return db.creatorStartsChatWorkers(resolveDispatchCreator(runtime, params.from, caller))
}

/** The start's mode: the host's settings, unless the caller's lineage starts its workers as chats. */
export function decideStartMode(
  runtime: Parameters<typeof startsInChatLineage>[0] &
    Parameters<typeof readWorkerStartModeSettings>[0],
  db: OrchestrationDb,
  params: Parameters<typeof decideWorkerStartMode>[0]['params'] & {
    from?: string
    retryOf?: string
  },
  caller: OrchestrationEntryCaller | undefined,
  followUp: { of: string } | undefined
): { mode: ReturnType<typeof decideWorkerStartMode>; chatLineage: boolean } {
  const chatLineage = startsInChatLineage(runtime, db, params, caller, followUp?.of)
  const settings = readWorkerStartModeSettings(runtime)
  return { mode: decideWorkerStartMode({ params, settings, chatLineage }), chatLineage }
}

/** A lineage start that had to take a terminal says why on its item too, where its owner looks. */
export function noteTerminalFallbackOnItem(
  runtime: Pick<OrcaRuntimeService, 'botItems'>,
  itemUid: string | undefined,
  receipt: unknown
): void {
  const parsed = TerminalFallbackReceipt.safeParse(receipt)
  if (!itemUid || !parsed.success || parsed.data.mode.mode !== 'terminal') {
    return
  }
  const text = `Worker dispatch:${parsed.data.dispatchId} started in a terminal. ${parsed.data.mode.detail}`
  void runtime.botItems
    .store()
    .orcaComment(itemUid, text, 'worker-start')
    .catch((error: unknown) => console.warn('[orchestration] item fallback note failed', error))
}

// A failed start reports a terminal mode too, but started nothing to note.
const TerminalFallbackReceipt = z.object({
  dispatchId: z.string(),
  state: z.enum(['ready', 'starting']),
  mode: z.object({ mode: z.string(), detail: z.string() })
})
