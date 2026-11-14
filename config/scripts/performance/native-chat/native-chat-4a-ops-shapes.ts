// 4a history/detail rows for named shapes: subagent grouping, huge tool originals, one above the detail reply cap, an
// oversized ordinary message and the seed's completed diff originals. Each shape is verified on the real route first.
import { read } from './native-chat-4a-ops-reads'
import { rpc, samplePressure } from './native-chat-4a-probes'
import type { Row } from './native-chat-4a-report'
import { addRow, page, sampled, tagFor, type RunContext } from './native-chat-4a-run-context'
import { createChat, history, send, waitForDurable, waitForIdle } from './native-chat-4a-session'
import { seededPatches } from './native-chat-4a-seed-diffs'
import { shapesPrompt, subagentPrompt, type Workload } from './native-chat-4a-workloads'

// JOURNAL_ITEM_DETAIL_MAX_BYTES on the candidate (journal-domain-history-metadata.ts): 4 MiB outbound JSON less 64 KiB.
const DETAIL_REPLY_CAP_BYTES = 4 * 1024 * 1024 - 64 * 1024
const MiB = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MiB`

type WireItem = {
  itemId: string
  agentId?: string
  body?: {
    kind?: string
    presentation?: string
    output?: { head?: string; byteLength?: number }
    patch?: { head?: string; byteLength?: number }
    blocks?: { text?: string }[]
  }
}
type Page = Awaited<ReturnType<typeof history>>['page']

/** One chat holding the turns' corpus, every turn durable and settled before any sample. */
async function corpusChat(ctx: RunContext, prompts: string[]): Promise<string> {
  const chat = await createChat(page(ctx), ctx.arm, ctx.manifest.workspace.worktreeIds[1])
  for (const prompt of prompts) {
    const tag = /"tag":"([^"]+)"/.exec(prompt)![1]
    await send(page(ctx), ctx.arm, chat.sessionId, prompt)
    await waitForDurable(page(ctx), chat.sessionId, `4A-TAIL-${tag}`, 600_000, 250)
    await waitForIdle(page(ctx), chat.sessionId, 600_000)
  }
  return chat.sessionId
}

const itemsOf = (read: Page): WireItem[] => read.items
const byProviderId = (items: WireItem[], id: string): WireItem | undefined =>
  items.find((item) => JSON.stringify(item).includes(`"${id}"`))

/** Fill a row only when `verify` names no mismatch; the observed shape stays in the row either way. */
async function verifiedRow(
  ctx: RunContext,
  row: Row,
  observed: Record<string, number | string>,
  mismatch: string | null,
  take: () => ReturnType<typeof read>
): Promise<void> {
  row.context = { ...row.context, ...observed }
  if (mismatch) {
    row.skipped = `shape not produced on this arm: ${mismatch}`
    ctx.log(`${row.family}/${row.operation}/${row.variant}: ${row.skipped}`)
    return
  }
  await sampled(ctx, row, ctx.workload.samples, take)
}

export async function subagentRows(ctx: RunContext): Promise<void> {
  const { subagents } = ctx.workload
  const corpora = [
    {
      mode: 'interleaved' as const,
      variant: `tail 200 (${subagents.agents} parallel agents × ${subagents.childrenPerAgent} children × ${subagents.interleavedTurns} turns)`,
      turns: subagents.interleavedTurns
    },
    {
      mode: 'sparse' as const,
      variant: `tail 200 (${subagents.sparseChildren} children under one agent, near-empty root)`,
      turns: 1
    }
  ]
  for (const corpus of corpora) {
    const sessionId = await corpusChat(
      ctx,
      Array.from({ length: corpus.turns }, () =>
        subagentPrompt(ctx.workload, tagFor(`sub-${corpus.mode}`), corpus.mode)
      )
    )
    const tail = await history(page(ctx), sessionId, 'tail', 200)
    const items = itemsOf(tail.page)
    const agentIds = items.map((item) => item.agentId ?? null)
    const subagentItems = agentIds.filter((id) => id !== null)
    const switches = subagentItems.filter(
      (id, index) => index > 0 && id !== subagentItems[index - 1]
    )
    const observed = {
      sessionId,
      pageItems: items.length,
      subagentItems: subagentItems.length,
      ownItems: items.length - subagentItems.length,
      distinctAgents: new Set(subagentItems).size,
      agentSwitches: switches.length
    }
    const mismatch =
      subagentItems.length === 0
        ? 'the tail page carries no item with agentId'
        : corpus.mode === 'interleaved' && observed.distinctAgents < subagents.agents
          ? `${observed.distinctAgents} distinct agents on the page`
          : corpus.mode === 'interleaved' && switches.length < subagents.childrenPerAgent
            ? `${switches.length} agent switches; children did not interleave`
            : corpus.mode === 'sparse' && observed.ownItems > subagentItems.length / 10
              ? `${observed.ownItems} own rows against ${subagentItems.length} subagent rows`
              : null
    const tailRow = addRow(ctx, {
      family: 'history',
      operation: `subagent grouping, ${corpus.mode}`,
      variant: corpus.variant,
      context: {}
    })
    await verifiedRow(ctx, tailRow, observed, mismatch, () =>
      read(ctx, 'agentSession.history', { sessionId, direction: 'tail', limit: 200 })
    )
    const older = addRow(ctx, {
      family: 'history',
      operation: `subagent grouping, ${corpus.mode}`,
      variant: 'one older page 200',
      context: {}
    })
    await verifiedRow(
      ctx,
      older,
      { hasOlder: Number(tail.page.hasOlder) },
      mismatch ?? (tail.page.hasOlder ? null : 'the corpus fits one page'),
      () =>
        read(ctx, 'agentSession.history', {
          sessionId,
          direction: 'before',
          limit: 200,
          cursor: tail.page.window.nextCursor
        })
    )
  }
}

/** Item detail with the main process's peak RSS while it answers, since worker-to-host bytes are not observable outside. */
const detail = (ctx: RunContext, sessionId: string, itemId: string) => async () => {
  const stop = samplePressure(ctx.launch.app, ctx.launch.userDataDir, 50)
  const sample = await read(ctx, 'agentSession.item', { sessionId, itemId })
  const pressure = await stop()
  return { ...sample, extra: { ...sample.extra, peakMainRssBytes: pressure.peakMainRssBytes } }
}

async function detailOf(ctx: RunContext, sessionId: string, itemId: string): Promise<WireItem> {
  return (await rpc<{ item: WireItem }>(page(ctx), 'agentSession.item', { sessionId, itemId }))
    .value.item
}

export async function itemShapeRows(ctx: RunContext): Promise<void> {
  const shapes: Workload['shapes'] = ctx.workload.shapes
  const tag = tagFor('shapes')
  const sessionId = await corpusChat(ctx, [shapesPrompt(ctx.workload, tag)])
  const tail = await history(page(ctx), sessionId, 'tail', 40)
  const items = itemsOf(tail.page)
  const huge = Array.from({ length: shapes.hugeTools }, (_, index) =>
    byProviderId(items, `toolu_4a_${tag}_huge_${index}`)
  )
  const cap = byProviderId(items, `toolu_4a_${tag}_cap`)
  const headBytes = (item: WireItem | undefined): number =>
    Buffer.byteLength(item?.body?.output?.head ?? '')
  const hugeMismatch = huge.some((item) => !item)
    ? `${huge.filter(Boolean).length} of ${shapes.hugeTools} huge tool items on the tail page`
    : huge.find((item) => item!.body?.output?.byteLength !== shapes.hugeToolBytes)
      ? 'a huge tool item does not report its whole original byteLength'
      : huge.find((item) => headBytes(item) >= shapes.hugeToolBytes)
        ? 'a huge tool item carries its whole original on the page'
        : null
  const hugeRow = addRow(ctx, {
    family: 'history',
    operation: 'huge completed tool originals, heads on one page',
    variant: `tail 40 (${shapes.hugeTools} × ${MiB(shapes.hugeToolBytes)} originals + ${MiB(shapes.capToolBytes)})`,
    context: { sessionId }
  })
  await verifiedRow(
    ctx,
    hugeRow,
    {
      originalBytes: shapes.hugeTools * shapes.hugeToolBytes + shapes.capToolBytes,
      largestHeadBytes: Math.max(...huge.map(headBytes), headBytes(cap))
    },
    hugeMismatch,
    () => read(ctx, 'agentSession.history', { sessionId, direction: 'tail', limit: 40 })
  )

  for (const [variant, item, bytes] of [
    ['original above the reply cap', cap, shapes.capToolBytes],
    ['huge original under the reply cap', huge[0], shapes.hugeToolBytes]
  ] as const) {
    const row = addRow(ctx, {
      family: 'history',
      operation: 'agentSession.item detail',
      variant,
      context: { originalBytes: bytes, replyCapBytes: DETAIL_REPLY_CAP_BYTES }
    })
    const full = item ? await detailOf(ctx, sessionId, item.itemId) : undefined
    const above = bytes > DETAIL_REPLY_CAP_BYTES
    const mismatch = !full
      ? 'item not found on the tail page'
      : full.body?.output?.byteLength !== bytes
        ? `detail reports ${full.body?.output?.byteLength} original bytes`
        : above && headBytes(full) >= bytes
          ? 'detail returned the whole original above the cap'
          : !above && headBytes(full) !== bytes
            ? 'detail shortened an original under the cap'
            : null
    await verifiedRow(ctx, row, { detailHeadBytes: headBytes(full) }, mismatch, () =>
      detail(ctx, sessionId, item!.itemId)()
    )
  }

  // The message's group exceeds every page budget, so the page that reaches it carries only its placeholder.
  let cursor: unknown
  let carrying: { cursor: unknown; item: WireItem } | null = null
  for (let pages = 0; pages < 4 && !carrying; pages += 1) {
    const at = await history(page(ctx), sessionId, cursor ? 'before' : 'tail', 40, cursor)
    const placeholder = itemsOf(at.page).find(
      (item) => item.body?.presentation === 'history-item-too-large'
    )
    carrying = placeholder ? { cursor, item: placeholder } : null
    if (!at.page.hasOlder) {
      break
    }
    cursor = at.page.window.nextCursor
  }
  const message = carrying ? await detailOf(ctx, sessionId, carrying.item.itemId) : undefined
  const text = message?.body?.blocks?.map((block) => block.text ?? '').join('') ?? ''
  const messageMismatch = !carrying
    ? 'no history-item-too-large placeholder within 4 pages'
    : !text.startsWith(`4A-BIG-${tag} `)
      ? 'the placeholder is not the seeded message'
      : Buffer.byteLength(text) !== shapes.messageBytes + `4A-BIG-${tag} `.length
        ? `detail returned ${Buffer.byteLength(text)} message bytes`
        : null
  const placeholderRow = addRow(ctx, {
    family: 'history',
    operation: 'oversized ordinary message placeholder',
    variant: `page reaching a ${MiB(shapes.messageBytes)} message`,
    context: { messageBytes: shapes.messageBytes }
  })
  await verifiedRow(
    ctx,
    placeholderRow,
    { detailTextBytes: Buffer.byteLength(text) },
    messageMismatch,
    () =>
      read(ctx, 'agentSession.history', {
        sessionId,
        direction: carrying!.cursor ? 'before' : 'tail',
        limit: 40,
        ...(carrying!.cursor ? { cursor: carrying!.cursor } : {})
      })
  )
  const messageDetail = addRow(ctx, {
    family: 'history',
    operation: 'agentSession.item detail',
    variant: 'oversized ordinary message (under the reply cap)',
    context: { messageBytes: shapes.messageBytes, replyCapBytes: DETAIL_REPLY_CAP_BYTES }
  })
  await verifiedRow(ctx, messageDetail, {}, messageMismatch, () =>
    detail(ctx, sessionId, carrying!.item.itemId)()
  )
  await diffRows(ctx)
}

/** The seed's known diff originals: kind, original length and a short page head, then the exact patch from detail. */
async function diffRows(ctx: RunContext): Promise<void> {
  const { sessionId, itemIds, patchBytes } = ctx.manifest.diffChat
  const patches = seededPatches(ctx.manifest.diffChat)
  const tail = await history(page(ctx), sessionId, 'tail', 40)
  const diffs = itemIds.map((itemId) => itemsOf(tail.page).find((item) => item.itemId === itemId))
  const patchHeadBytes = (item: WireItem | undefined): number =>
    Buffer.byteLength(item?.body?.patch?.head ?? '')
  const mismatch = !patches
    ? 'the harness generates other patches than the seed wrote'
    : diffs.some((item) => !item)
      ? `${diffs.filter(Boolean).length} of ${itemIds.length} seeded diff items on the tail page`
      : diffs.find(
            (item) => item!.body?.kind !== 'diff' || item!.body.patch?.byteLength !== patchBytes
          )
        ? 'a seeded item is not a diff reporting its whole original byteLength'
        : diffs.find(
              (item, index) =>
                patchHeadBytes(item) === 0 ||
                patchHeadBytes(item) >= patchBytes ||
                !patches[index]!.startsWith(item!.body!.patch!.head!)
            )
          ? 'a diff item carries no short head of its own patch on the page'
          : null
  const pageRow = addRow(ctx, {
    family: 'history',
    operation: 'completed diff originals, heads on one page',
    variant: `tail 40 (${itemIds.length} × ${MiB(patchBytes)} diff originals)`,
    context: { sessionId }
  })
  const observed = {
    originalBytes: itemIds.length * patchBytes,
    largestHeadBytes: Math.max(0, ...diffs.map(patchHeadBytes))
  }
  await verifiedRow(ctx, pageRow, observed, mismatch, () =>
    read(ctx, 'agentSession.history', { sessionId, direction: 'tail', limit: 40 })
  )
  const detailRow = addRow(ctx, {
    family: 'history',
    operation: 'agentSession.item detail',
    variant: 'completed diff original under the reply cap',
    context: { originalBytes: patchBytes, replyCapBytes: DETAIL_REPLY_CAP_BYTES }
  })
  const full = mismatch ? undefined : await detailOf(ctx, sessionId, itemIds[0]!)
  const detailMismatch =
    mismatch ??
    (full?.body?.patch?.head === patches![0] && patchBytes < DETAIL_REPLY_CAP_BYTES
      ? null
      : `detail returned ${patchHeadBytes(full)} of ${patchBytes} B, not the exact seeded patch under the cap`)
  await verifiedRow(ctx, detailRow, { detailHeadBytes: patchHeadBytes(full) }, detailMismatch, () =>
    detail(ctx, sessionId, itemIds[0]!)()
  )
}
