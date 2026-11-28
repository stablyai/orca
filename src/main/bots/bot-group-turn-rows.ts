import type { z } from 'zod'
import type { BotGroupTurnRows } from '../../shared/bots/bot-group'
import { requireStructuredHost } from './bot-chat-session'
import type { BotGroupTurnDetailPage } from '../../shared/bots/use-bot-group-turn-details'
import { orchestrationReader } from '../runtime/orchestration/db/reader-worker/orchestration-reader-client'
import type { BotGroupRuntime } from './bot-group-runtime'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'

const MAX_GROUP_DETAIL_READS = 8
const MAX_GROUP_DETAIL_WAITERS = 32

export type BotGroupTurnRead = {
  page: Promise<BotGroupTurnDetailPage>
  controller: AbortController
  viewers: number
}

/** A room's own operation, requested only while its details are open. */
export async function readBotGroupTurnRows(
  groups: BotGroupRuntime,
  input: z.infer<typeof BotGroupTurnRows>,
  signal?: AbortSignal,
  client?: string
): Promise<BotGroupTurnDetailPage> {
  const viewerKey = client && input.requestId ? JSON.stringify([client, input.requestId]) : null
  if (input.cancel) {
    if (viewerKey) {
      groups.turnDetailViewers.get(viewerKey)?.abort()
    }
    return { items: [] }
  }
  signal?.throwIfAborted()
  const viewer = viewerKey ? new AbortController() : null
  if (viewerKey && viewer) {
    if (groups.turnDetailViewers.has(viewerKey)) {
      throw new Error('This group turn detail request is already running.')
    }
    groups.turnDetailViewers.set(viewerKey, viewer)
  }
  try {
    const watching =
      viewer && signal ? AbortSignal.any([viewer.signal, signal]) : (viewer?.signal ?? signal)
    return await waitForTurnPage(groups, input, watching)
  } finally {
    if (viewerKey) {
      groups.turnDetailViewers.delete(viewerKey)
    }
  }
}

async function waitForTurnPage(
  groups: BotGroupRuntime,
  input: z.infer<typeof BotGroupTurnRows>,
  signal?: AbortSignal
): Promise<BotGroupTurnDetailPage> {
  const reads = groups.turnDetailReads
  const key = JSON.stringify([input.groupId, input.threadId, input.operationId, input.before])
  let running = reads.get(key)
  if (!running) {
    while (reads.size >= MAX_GROUP_DETAIL_READS) {
      await waitForDetailSlot(groups, signal)
      running = reads.get(key)
      if (running) {
        break
      }
    }
    if (!running) {
      const controller = new AbortController()
      const pending = {
        controller,
        viewers: 0,
        page: readTurnPage(groups, input, controller.signal).finally(() => {
          if (reads.get(key) === pending) {
            reads.delete(key)
            groups.turnDetailWaiters.shift()?.()
          }
        })
      }
      reads.set(key, pending)
      running = pending
    }
  }
  running.viewers++
  try {
    return await waitForPromiseWithSignal(running.page, signal)
  } finally {
    if (--running.viewers === 0 && reads.get(key) === running) {
      reads.delete(key)
      running.controller.abort()
      groups.turnDetailWaiters.shift()?.()
    }
  }
}

function waitForDetailSlot(groups: BotGroupRuntime, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (groups.turnDetailWaiters.length >= MAX_GROUP_DETAIL_WAITERS) {
    throw new Error('Too many group turn detail reads are waiting.')
  }
  return new Promise((resolve, reject) => {
    const wake = () => {
      cleanup()
      resolve()
    }
    const abort = () => {
      cleanup()
      reject(signal?.reason)
    }
    const cleanup = () => {
      const index = groups.turnDetailWaiters.indexOf(wake)
      if (index !== -1) {
        groups.turnDetailWaiters.splice(index, 1)
      }
      signal?.removeEventListener('abort', abort)
    }
    groups.turnDetailWaiters.push(wake)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function readTurnPage(
  groups: BotGroupRuntime,
  { groupId, threadId, operationId, before }: z.infer<typeof BotGroupTurnRows>,
  signal: AbortSignal
): Promise<BotGroupTurnDetailPage> {
  const source = groups.store.detailSource(operationId)
  if (!source) {
    return { items: [] }
  }
  const turn = await orchestrationReader().read(
    groups.store,
    'botGroupTurnSource',
    { ...source, groupId, threadId, operationId, before: before?.journal?.[0] },
    signal
  )
  signal.throwIfAborted()
  if (!turn) {
    return { items: [] }
  }
  if (turn.kind === 'frozen') {
    return turn.page
  }
  const workers =
    !before || before.worker !== undefined
      ? groups.store.db
          .prepare(`SELECT rowid AS position, dispatch_id FROM bot_group_worker_operations
        WHERE operation_id=? AND rowid<? ORDER BY rowid DESC LIMIT 33`)
          .all(operationId, before?.worker ?? Number.MAX_SAFE_INTEGER)
      : []
  const host = await requireStructuredHost(groups.runtime)
  signal.throwIfAborted()
  const reads = await host.journalReads(turn.sessionId)
  signal.throwIfAborted()
  const page = await reads.roomTurnPage(
    {
      operationId,
      turnItemId: turn.turnItemId,
      workerDispatchIds: workers.slice(0, 32).map((worker) => String(worker.dispatch_id)),
      before: before?.journal,
      onlyWorkers: before !== undefined && before.journal === undefined
    },
    signal
  )
  const worker =
    workers.length > page.workersRead
      ? Number(workers[page.workersRead - 1]?.position ?? before?.worker ?? Number.MAX_SAFE_INTEGER)
      : undefined
  return {
    items: page.items,
    ...(page.before || worker !== undefined ? { before: { journal: page.before, worker } } : {})
  }
}
