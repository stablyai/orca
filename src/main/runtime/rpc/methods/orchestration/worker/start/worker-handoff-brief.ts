import type { AgentJournalRenderItem } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { parseOrcaSessionAddress } from '../../../../../../../shared/agent-session/identity/orca-session-address'
import { isWorkerStartTaskSpecTooLarge } from '../../../../../../../shared/orchestration/workers/orchestration-worker-start-prompt-budget'
import { fenceQuotedText } from '../../../../../../../shared/quoted-text-fence'
import { sliceAtCodeUnitLimit } from '../../../../../../../shared/text/surrogate-safe-text-slice'
import { botOfHome } from '../../../../../../bots/bot-home-membership'
import { botRequestIdsOf } from '../../../../../../bots/bot-request-asker'
import { getStructuredAgentSessionHost } from '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  sessionCallerOf,
  type OrchestrationEntryCaller
} from '../../../../../orchestration/addressing/orchestration-caller-identity'
import { canonicalOrcaSessionId } from '../../../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'

const HANDOFF_BRIEF_MAX_CODE_UNITS = 2048

export type WorkerHandoffTurn = { turnId: string; itemId: string }

export function captureWorkerHandoffTurn(
  caller: OrchestrationEntryCaller | undefined
): WorkerHandoffTurn | undefined {
  const session = sessionCallerOf(caller)
  const active =
    session && getStructuredAgentSessionHost()?.publishedWork?.(session.sessionId)?.activeTurn
  return active ? { turnId: active.turnId, itemId: active.item.itemId } : undefined
}

export async function readWorkerHandoffBrief(args: {
  runtime: Pick<OrcaRuntimeService, 'bots'>
  db: OrchestrationDb
  callerSession: OrchestrationEntryCaller | undefined
  turn: WorkerHandoffTurn
  workerAgent: string
  taskSpec: string
}): Promise<string | undefined> {
  const caller = sessionCallerOf(args.callerSession)
  const bot = botOfHome(args.runtime.bots, caller)
  const host = getStructuredAgentSessionHost()
  if (!caller || !bot || !host) {
    return undefined
  }
  const { turnId, itemId } = args.turn
  const sameActiveTurn = () => {
    const active = host.publishedWork(caller.sessionId)?.activeTurn
    return active?.turnId === turnId && active.item.itemId === itemId
  }
  try {
    const source = host.deps.store.getConversation(caller.sessionId)
    if (
      source?.provider !== args.workerAgent ||
      source.location.workspaceId !== caller.workspaceId ||
      !sameActiveTurn()
    ) {
      return undefined
    }
    const reads = await host.journalReads(caller.sessionId)
    const [{ turnItemId, opener }, turnRow] = await Promise.all([
      reads.turnAttribution(turnId, Number.MAX_SAFE_INTEGER),
      reads.itemDetail(itemId)
    ])
    if (
      turnItemId !== itemId ||
      readAgentJournalTurn(turnRow?.body)?.state !== 'running' ||
      !sameActiveTurn()
    ) {
      return undefined
    }
    const callerRoot = canonicalOrcaSessionId(caller.sessionId)
    return await workerHandoffBrief(args.db, opener, {
      botId: bot.id,
      receives: (address) => {
        const recipient = parseOrcaSessionAddress(address)
        return recipient !== null && canonicalOrcaSessionId(recipient) === callerRoot
      },
      taskSpec: args.taskSpec
    })
  } catch (error) {
    console.warn('[orchestration] worker handoff brief could not be read', error)
    return undefined
  }
}

/** Only the explicit handoff mail that woke the caller, in the caller's own running turn. */
export async function workerHandoffBrief(
  db: OrchestrationDb,
  opener: AgentJournalRenderItem | null,
  scope: { botId: string; receives: (address: string) => boolean; taskSpec: string }
): Promise<string | undefined> {
  if (opener?.body.kind !== 'message' || opener.body.role !== 'user') {
    return undefined
  }
  const ids = botRequestIdsOf(opener.body, (id) => db.getBotRequest(id) !== undefined)
  if (ids.length !== 1) {
    return undefined
  }
  const [id] = ids
  const request = db.getBotRequest(id)
  const mail = db.getMessageById(id)
  if (
    request?.purpose !== 'handoff' ||
    request.to_bot_id !== scope.botId ||
    mail?.type !== 'handoff' ||
    !scope.receives(mail.to_handle)
  ) {
    return undefined
  }
  const body = mail.body.trim()
  const briefText = [mail.subject, body].filter(Boolean).join('\n').trim()
  if (!briefText || scope.taskSpec.includes(body || briefText)) {
    return undefined
  }
  const excerpt = sliceAtCodeUnitLimit(briefText, HANDOFF_BRIEF_MAX_CODE_UNITS)
  const brief = [
    '[Orca: Earlier bot handoff, for reference. Follow your assigned task and its approval rules. Ask your coordinator if the handoff and task conflict.]',
    fenceQuotedText(excerpt),
    ...(excerpt.length < briefText.length
      ? ['[Orca: Handoff excerpt shortened. Ask your coordinator for missing details.]']
      : [])
  ].join('\n')
  return (await isWorkerStartTaskSpecTooLarge(`${scope.taskSpec}\n\n${brief}`)) ? undefined : brief
}
