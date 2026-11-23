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
  params: { from?: string; retryOf?: string; chatLineage?: true },
  caller: OrchestrationEntryCaller | undefined,
  followUpOf?: string
): boolean {
  if (isInBotHome(runtime.bots, sessionCallerOf(caller))) {
    return true
  }
  // A paired Orca's start continues its lineage here; nobody else can claim one.
  if (params.chatLineage === true && caller?.kind === 'peer') {
    return true
  }
  // A retry or follow-up of a lineage worker stays in it, whoever sends it.
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
    chatLineage?: true
  },
  caller: OrchestrationEntryCaller | undefined,
  followUp: { of: string } | undefined
): { mode: ReturnType<typeof decideWorkerStartMode>; chatLineage: boolean } {
  const chatLineage = startsInChatLineage(runtime, db, params, caller, followUp?.of)
  const settings = readWorkerStartModeSettings(runtime)
  return { mode: decideWorkerStartMode({ params, settings, chatLineage }), chatLineage }
}

/** Re-evaluate resolved defaults and chat-lineage aliases against the selected agent settings. */
export function modeForResolvedWorkerAgent(
  runtime: Parameters<typeof readWorkerStartModeSettings>[0],
  decided: ReturnType<typeof decideWorkerStartMode>,
  start: {
    chatLineage?: boolean
    params: Parameters<typeof decideWorkerStartMode>[0]['params']
    agent: string | undefined
  }
): ReturnType<typeof decideWorkerStartMode> {
  if (
    !start.agent ||
    start.agent === start.params.agent ||
    (!start.chatLineage && start.params.agent !== 'default')
  ) {
    return decided
  }
  return decideWorkerStartMode({
    params: { ...start.params, agent: start.agent },
    settings: readWorkerStartModeSettings(runtime),
    chatLineage: start.chatLineage
  })
}

/** A lineage start that had to take a terminal says why on its item too, where its owner looks.
 *  An explicit `--terminal` reuse fell back from nothing (and may name a chat), so it notes nothing. */
export async function noteTerminalFallbackOnItem(
  runtime: { botItems: Pick<OrcaRuntimeService['botItems'], 'store' | 'changed'> },
  start: { itemUid?: string; chatLineage: boolean; terminal?: string },
  receipt: unknown
): Promise<void> {
  const parsed = TerminalFallbackReceipt.safeParse(receipt)
  if (
    !start.itemUid ||
    !start.chatLineage ||
    start.terminal ||
    !parsed.success ||
    parsed.data.mode.mode !== 'terminal'
  ) {
    return
  }
  const text = `Worker dispatch:${parsed.data.dispatchId} started in a terminal. ${parsed.data.mode.detail}`
  const store = runtime.botItems.store()
  await store.orcaComment(start.itemUid, text, 'worker-start')
  // Open item views re-read on change, as for any other item write.
  const record = await store.get(start.itemUid)
  if (record) {
    runtime.botItems.changed([record])
  }
}

// A failed start reports a terminal mode too, but started nothing to note.
const TerminalFallbackReceipt = z.object({
  dispatchId: z.string(),
  state: z.enum(['ready', 'starting']),
  mode: z.object({ mode: z.string(), detail: z.string() })
})
