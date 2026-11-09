// 4a read rows on the retained large chat: history pages, item detail, outline, fork, and record operations on the many-chat profile.
import { randomUUID } from 'node:crypto'
import { operationId } from './native-chat-4a-arm'
import { rpc } from './native-chat-4a-probes'
import type { Sample } from './native-chat-4a-report'
import {
  addRow,
  measured,
  page,
  sampled,
  tagFor,
  type RunContext
} from './native-chat-4a-run-context'
import { createChat, history, mutate, userItemIds, waitForIdle } from './native-chat-4a-session'

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

type Item = { id: string; body?: { kind?: string } }

async function read(
  ctx: RunContext,
  method: string,
  params: unknown,
  allowRefusal = false
): Promise<Sample> {
  return measured(ctx, async () => {
    const answer = await rpc(page(ctx), method, params, allowRefusal ? { allowRefusal: true } : {})
    return {
      hostMs: answer.hostMs,
      extra: { bytes: bytesOf(answer.value), refused: Number(answer.refused) }
    }
  })
}

export async function historyRows(ctx: RunContext): Promise<void> {
  const sessionId = ctx.manifest.largeSessionId
  const n = ctx.workload.samples
  const context = { largeItems: ctx.manifest.largeItems }
  const tail = await history(page(ctx), sessionId, 'tail', 200)
  const older = await history(page(ctx), sessionId, 'before', 200, tail.page.window.nextCursor)
  const catchUpFrom = older.page.window.nextCursor
  const pages: [string, Record<string, unknown>][] = [
    ['tail 40', { direction: 'tail', limit: 40 }],
    ['tail 200 (same page repeated)', { direction: 'tail', limit: 200 }],
    [
      'one older page 200',
      { direction: 'before', limit: 200, cursor: tail.page.window.nextCursor }
    ],
    ['ordinary after catch-up 200', { direction: 'after', limit: 200, cursor: catchUpFrom }],
    [
      'stale epoch reset catch-up',
      { direction: 'after', limit: 200, cursor: { epoch: 'stale-4a-epoch', sequence: 1 } }
    ]
  ]
  for (const [variant, params] of pages) {
    const row = addRow(ctx, {
      family: 'history',
      operation: 'agentSession.history',
      variant,
      context
    })
    await sampled(ctx, row, n, () =>
      read(ctx, 'agentSession.history', { sessionId, ...params }, true)
    )
  }
  addRow(ctx, {
    family: 'history',
    operation: 'sparse/interleaved subagent grouping',
    variant: 'tail 200',
    context,
    skipped:
      'the 4a provider stub emits no subagent frames; covered by the Claude/Codex functional QA run'
  })

  // Huge originals come from the streaming rows that ran first; the smallest seeded tool item is the ordinary case.
  const items = [...tail.page.items, ...older.page.items] as Item[]
  const sized = items
    .map((item) => ({ item, bytes: bytesOf(item) }))
    .sort((a, b) => b.bytes - a.bytes)
  const ordinary = sized.findLast((entry) => entry.item.body?.kind === 'tool-call') ?? sized.at(-1)
  const largest = sized[0]
  for (const [variant, entry] of [
    ['ordinary tool item', ordinary],
    ['largest item on the tail pages', largest]
  ] as const) {
    const row = addRow(ctx, {
      family: 'history',
      operation: 'agentSession.item detail',
      variant,
      context: { wireHeadBytes: entry?.bytes ?? 0 }
    })
    if (!entry) {
      row.skipped = 'no item on the tail pages'
      continue
    }
    await sampled(ctx, row, n, () =>
      read(ctx, 'agentSession.item', { sessionId, itemId: entry.item.itemId })
    )
  }
}

export async function outlineAndForkRows(ctx: RunContext): Promise<void> {
  const sessionId = ctx.manifest.largeSessionId
  const outline = addRow(ctx, {
    family: 'outline',
    operation: 'conversationOutline',
    variant: 'repeated (warm)',
    context: { largeItems: ctx.manifest.largeItems }
  })
  await sampled(ctx, outline, ctx.workload.samples, () =>
    read(ctx, 'agentSession.conversationOutline', { sessionId })
  )

  const [tip] = (await userItemIds(page(ctx), sessionId, 1)).slice(-1)
  const fork = addRow(ctx, {
    family: 'outline',
    operation: 'tip fork (create forkFrom)',
    variant: 'large chat tip',
    context: { historicalSubmissions: ctx.workload.history.largeTurns },
    endToEndOnly: 'local validation and provider copy are one host span'
  })
  if (!tip) {
    fork.skipped = 'no user item on the large chat'
    return
  }
  await sampled(ctx, fork, Math.min(ctx.workload.samples, 10), () =>
    measured(ctx, async () => {
      const created = await createChat(page(ctx), ctx.arm, ctx.manifest.workspace.worktreeIds[0], {
        sessionId,
        throughItemId: tip
      })
      const readyStarted = Date.now()
      const first = await history(page(ctx), created.sessionId, 'tail', 40)
      return {
        hostMs: created.hostMs,
        extra: { forkTailReadMs: Date.now() - readyStarted, forkTailItems: first.page.items.length }
      }
    })
  )
}

export async function recordRows(ctx: RunContext): Promise<void> {
  const { fillerSessionIds } = ctx.manifest
  const chats = fillerSessionIds.length + 1
  const targets = [fillerSessionIds[0]!, fillerSessionIds.at(-1)!]
  const rename = addRow(ctx, {
    family: 'records',
    operation: 'rename',
    variant: 'point lookup, first and last chat',
    context: { chats }
  })
  await sampled(ctx, rename, ctx.workload.samples, (index) =>
    measured(ctx, async () => {
      const name = tagFor('name')
      const answer = await rpc(page(ctx), 'agentSession.rename', {
        sessionId: targets[index % 2]!,
        name
      })
      const shownAt = await page(ctx)
        .waitForFunction(
          (name) =>
            [...document.querySelectorAll('[data-testid="sortable-tab"]')].some((tab) =>
              tab.textContent?.includes(name)
            ) && performance.now(),
          name,
          { timeout: 60_000, polling: 16 }
        )
        .then(async (handle) => (await handle.jsonValue()) as number)
        .catch(() => Number.NaN)
      return {
        hostMs: answer.hostMs,
        e2eMs: shownAt - answer.startedAt,
        extra: { tabNotShown: Number(Number.isNaN(shownAt)) }
      }
    })
  )

  const option = addRow(ctx, {
    family: 'records',
    operation: 'option update (setOption model)',
    variant: 'idle small chat',
    context: { chats }
  })
  await sampled(ctx, option, ctx.workload.samples, () =>
    measured(ctx, async () => {
      const answer = await mutate(page(ctx), ctx.arm, 'agentSession.setOption', targets[0]!, {
        key: 'model',
        value: 'default'
      })
      await waitForIdle(page(ctx), targets[0]!)
      return { hostMs: answer.hostMs }
    })
  )

  // Resuming a provider session another chat already adopted makes the host find that chat by provider ID.
  const adopted = addRow(ctx, {
    family: 'records',
    operation: 'adopted-handle lookup (create resumeFrom)',
    variant: 'provider id of last chat',
    context: { chats }
  })
  const provider = (
    await rpc<{ providerSession?: { id?: string } }>(page(ctx), 'agentSession.history', {
      sessionId: targets[1]!,
      direction: 'tail',
      limit: 1
    })
  ).value.providerSession?.id
  if (!provider) {
    adopted.skipped = 'history named no provider session for the last chat'
    return
  }
  await sampled(ctx, adopted, ctx.workload.samples, () =>
    measured(ctx, async () => {
      const sessionId = ctx.arm.protocol.createStructuredAgentSessionId('claude', randomUUID)
      const worktree = `id:${ctx.manifest.workspace.worktreeIds[1]}`
      const resumeFrom = { providerSessionId: provider }
      const fingerprint = ctx.arm.protocol.structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId,
        fields: { worktree, agent: 'claude', resumeFrom }
      })
      const envelope = {
        sessionId,
        clientOperationId: operationId(ctx.arm),
        expectedRuntimeFence: null,
        payloadFingerprint: fingerprint
      }
      const answer = await rpc(
        page(ctx),
        'agentSession.create',
        { envelope, worktree, agent: 'claude', resumeFrom },
        { allowRefusal: true }
      )
      return { hostMs: answer.hostMs, extra: { refused: Number(answer.refused) } }
    })
  )
}
