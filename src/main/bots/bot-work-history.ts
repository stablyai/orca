import type { BotWorkerSummary } from '../../shared/bots/bot-work-list'
import { ownPullRequest } from './bot-work-pr-match'
import { cleanBotWorkText } from './bot-work-turn-note'
import type { BotWorkCheck, BotWorkRecordDeps } from './bot-work-types'

export function summarizeBotWork(
  deps: Pick<BotWorkRecordDeps, 'conversationTitle'>,
  { row, worker, workspace }: BotWorkCheck
): BotWorkerSummary {
  const linked =
    row.askedInApp && row.address.source !== 'chat' ? null : deps.conversationTitle(row.address)
  return {
    id: row.rowId,
    title: cleanBotWorkText(worker?.title ?? `dispatch:${row.dispatchId}`),
    agent: worker?.agent ?? null,
    state: worker?.state ?? null,
    ...(row.closedAt === null && worker?.idle ? { idle: true } : {}),
    ...(row.closedAt === null ? {} : { closedAt: row.closedAt }),
    dispatchId: worker?.dispatchId ?? row.dispatchId,
    workspace: workspace ? cleanBotWorkText(workspace.name) : null,
    server: worker?.hostName ? cleanBotWorkText(worker.hostName) : null,
    pr: workspace ? ownPullRequest(workspace) : null,
    startedAt: worker?.startedAt ?? null,
    source: {
      source: row.askedInApp || row.address.source === 'chat' ? 'app' : row.address.source,
      title: linked ? cleanBotWorkText(linked) : null
    }
  }
}

export async function readBotWorkHistory(
  deps: BotWorkRecordDeps,
  botId: string
): Promise<BotWorkerSummary[]> {
  const rows = await deps.store().recentClosedRows(botId)
  if (rows.length === 0) {
    return []
  }
  const workers = await deps.workers(rows.map((row) => row.dispatchId)).catch(() => null)
  const readWorkspace = deps.workspaces()
  const items: BotWorkerSummary[] = []
  for (const row of rows) {
    const read = workers?.get(row.dispatchId)
    // Never attribute a later retry's state or PR to an older closed record.
    const worker = read?.dispatchId === row.dispatchId && read.host === row.host ? read : null
    const workspace = worker ? await readWorkspace(worker).catch(() => null) : null
    const item = summarizeBotWork(deps, {
      row,
      worker,
      workspace: workspace === 'gone' ? null : workspace
    })
    if (item.state !== 'completed' && item.state !== 'failed' && item.state !== 'stopped') {
      item.state =
        row.closeReason === 'stopped'
          ? 'stopped'
          : row.closeReason === 'start_failed'
            ? 'failed'
            : null
    }
    items.push(item)
  }
  return items
}
