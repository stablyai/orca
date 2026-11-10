// Classify outline reads from persisted source/cache keys, independently of process warmth or UI restoration.
import { rpc } from './native-chat-4a-probes'
import {
  addRow,
  measured,
  page,
  sampled,
  tagFor,
  type RunContext
} from './native-chat-4a-run-context'
import { openChatTab, send, waitForDurable, waitForIdle } from './native-chat-4a-session'
import { chatDatabasePath } from './native-chat-4a-sqlite-observer'
import {
  outlineCacheContains,
  outlineCacheState,
  type OutlineCacheState
} from './native-chat-4a-source-observer'
import { replyPrompt } from './native-chat-4a-workloads'

const sourceKey = (state: OutlineCacheState): string =>
  JSON.stringify([state.epoch, state.sequence, state.revision])

export async function outlineCacheRows(ctx: RunContext): Promise<void> {
  const sessionId = ctx.manifest.largeSessionId
  const file = chatDatabasePath(ctx.launch.userDataDir)
  const context = {
    largeItems: ctx.manifest.largeItems,
    observation:
      'outside read-only source epoch/sequence/submissions revision and persisted cache key/budget; served JSON equality'
  }
  const hit = addRow(ctx, {
    family: 'outline',
    operation: 'conversationOutline, confirmed persisted hit',
    variant: 'large chat',
    context
  })
  const invalidation = addRow(ctx, {
    family: 'outline',
    operation: 'persisted outline invalidation after real send',
    variant: 'large chat',
    context
  })
  const miss = addRow(ctx, {
    family: 'outline',
    operation: 'conversationOutline, observed source-key miss',
    variant: 'large chat',
    context
  })
  const rows = [hit, invalidation, miss]
  const tag = tagFor('invalidate')
  await openChatTab(
    page(ctx),
    ctx.manifest.workspace.worktreeIds[1],
    ctx.manifest.fillerSessionIds[0]!
  )
  await waitForIdle(page(ctx), sessionId)
  if (!file || !outlineCacheState(file, sessionId)) {
    // Both arms receive the same real mutation even when one has no persisted cache.
    await send(page(ctx), ctx.arm, sessionId, replyPrompt(tag))
    await waitForDurable(page(ctx), sessionId, `4A-TAIL-${tag}`)
    await waitForIdle(page(ctx), sessionId)
    for (const row of rows) {
      row.skipped = 'arm has no persisted outline-cache table; cache classification unavailable'
    }
    return
  }
  try {
    await rpc(page(ctx), 'agentSession.conversationOutline', { sessionId })
    const deadline = Date.now() + 30_000
    let cached = outlineCacheState(file, sessionId)!
    while (!cached.matchesSource && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      cached = outlineCacheState(file, sessionId)!
    }
    if (!cached.matchesSource) {
      throw new Error('outline materialization was not persisted for the current source')
    }
    await sampled(ctx, hit, ctx.workload.samples, async () => {
      const before = outlineCacheState(file, sessionId)!
      if (!before.matchesSource) {
        throw new Error('persisted hit precondition lost')
      }
      let served: unknown
      const sample = await measured(ctx, async () => {
        const answer = await rpc(page(ctx), 'agentSession.conversationOutline', { sessionId })
        served = answer.value
        return { hostMs: answer.hostMs }
      })
      const after = outlineCacheState(file, sessionId)!
      if (
        !after.matchesSource ||
        sourceKey(before) !== sourceKey(after) ||
        before.budgetBytes !== after.budgetBytes ||
        !outlineCacheContains(file, sessionId, served)
      ) {
        throw new Error('persisted cache/source key or served value changed during hit')
      }
      return {
        ...sample,
        extra: {
          sourceSequence: before.sequence,
          sourceRevision: before.revision,
          cacheBudgetBytes: before.budgetBytes!
        }
      }
    })
    if (hit.skipped) {
      throw new Error(hit.skipped)
    }
    const before = outlineCacheState(file, sessionId)!
    const mutation = await measured(ctx, async () => {
      const started = Date.now()
      const answer = await send(page(ctx), ctx.arm, sessionId, replyPrompt(tag))
      await waitForDurable(page(ctx), sessionId, `4A-TAIL-${tag}`)
      await waitForIdle(page(ctx), sessionId)
      return { hostMs: answer.hostMs, e2eMs: Date.now() - started }
    })
    const stale = outlineCacheState(file, sessionId)!
    invalidation.context = {
      ...context,
      sourceKeyBefore: sourceKey(before),
      sourceKeyAfter: sourceKey(stale)
    }
    if (sourceKey(before) === sourceKey(stale) || stale.matchesSource) {
      throw new Error(
        'mutation did not leave an observed invalid cache key; no invalidation/miss claim'
      )
    }
    invalidation.samples.push({
      ...mutation,
      extra: {
        sourceSequence: stale.sequence,
        cacheSequence: stale.cacheSequence ?? Number.NaN,
        sourceRevision: stale.revision,
        cacheRevision: stale.cacheRevision ?? Number.NaN
      }
    })
    await sampled(ctx, miss, 1, async () => {
      const atRequest = outlineCacheState(file, sessionId)!
      if (atRequest.matchesSource || sourceKey(atRequest) !== sourceKey(stale)) {
        throw new Error('observed miss precondition lost before request')
      }
      const sample = await measured(ctx, async () => ({
        hostMs: (await rpc(page(ctx), 'agentSession.conversationOutline', { sessionId })).hostMs
      }))
      if (sourceKey(outlineCacheState(file, sessionId)!) !== sourceKey(atRequest)) {
        throw new Error('source changed during observed miss')
      }
      return {
        ...sample,
        extra: {
          sourceSequence: atRequest.sequence,
          cacheSequence: atRequest.cacheSequence ?? Number.NaN,
          sourceRevision: atRequest.revision,
          cacheRevision: atRequest.cacheRevision ?? Number.NaN
        }
      }
    })
  } catch (error) {
    for (const row of rows.filter((entry) => entry.samples.length === 0 && !entry.skipped)) {
      row.skipped = `classification failed: ${String(error).slice(0, 250)}`
    }
  }
}
