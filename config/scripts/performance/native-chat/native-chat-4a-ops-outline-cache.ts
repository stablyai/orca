// Classify outline reads from persisted source/cache keys, independently of process warmth or UI restoration.
import { admitOutline, outlineSourceKey as sourceKey } from './native-chat-4a-cache-admission'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../../../../src/main/native-chat/agent-session-wire/publication/history/agent-session-history-page-bounds'
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
    operation: 'conversationOutline, observed source-key/budget miss',
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
  const observe = (): OutlineCacheState => {
    const state = outlineCacheState(file, sessionId)
    if (!state) {
      throw new Error('persisted cache observation unavailable')
    }
    return {
      ...state,
      matchesSource: state.matchesSource && state.budgetBytes === HISTORY_PAGE_CONTENT_BUDGET_BYTES
    }
  }
  const attempts: OutlineCacheState[] = []
  let observations = 0
  let requests = 0
  const admit = () =>
    admitOutline({
      observe,
      record: (state) => {
        observations += 1
        if (attempts.length < 320 && JSON.stringify(attempts.at(-1)) !== JSON.stringify(state)) {
          attempts.push(state)
        }
      },
      request: async (before) => {
        const sample = await measured(ctx, async () => {
          const atRequest = observe()
          if (
            !atRequest.eligible ||
            atRequest.matchesSource ||
            sourceKey(before) !== sourceKey(atRequest)
          ) {
            return {}
          }
          requests += 1
          const answer = await rpc(page(ctx), 'agentSession.conversationOutline', { sessionId })
          return { hostMs: answer.hostMs, evidence: { cacheBefore: atRequest } }
        })
        if (
          sample.evidence &&
          sourceKey(observe()) === sourceKey(before) &&
          miss.samples.length === 0
        ) {
          miss.samples.push(sample)
        }
      }
    })
  let cached: OutlineCacheState | undefined
  try {
    cached = await admit()
    await sampled(ctx, hit, ctx.workload.samples, async () => {
      const before = observe()
      if (!before.matchesSource || !before.eligible) {
        throw new Error('persisted hit precondition lost')
      }
      let served: unknown
      const sample = await measured(ctx, async () => {
        const answer = await rpc(page(ctx), 'agentSession.conversationOutline', { sessionId })
        served = answer.value
        return { hostMs: answer.hostMs }
      })
      const after = observe()
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
        evidence: { cacheBefore: before, cacheAfter: after, servedEqualsPersisted: true }
      }
    })
  } catch (error) {
    hit.skipped = `unexercised: ${String(error).slice(0, 250)}`
  }
  // Every arm performs this same real mutation even if admission was unavailable.
  try {
    const before = observe()
    const mutation = await measured(ctx, async () => {
      const started = Date.now()
      const answer = await send(page(ctx), ctx.arm, sessionId, replyPrompt(tag))
      await waitForDurable(page(ctx), sessionId, `4A-TAIL-${tag}`)
      await waitForIdle(page(ctx), sessionId)
      return { hostMs: answer.hostMs, e2eMs: Date.now() - started }
    })
    const stale = observe()
    if (
      !cached ||
      !before.matchesSource ||
      sourceKey(before) === sourceKey(stale) ||
      stale.matchesSource
    ) {
      invalidation.skipped =
        'real mutation lacked an observed persisted-hit to stale-cache transition; unexercised'
    } else {
      invalidation.samples.push({
        ...mutation,
        evidence: { cacheBefore: before, cacheAfter: stale }
      })
    }
    await admit()
  } catch (error) {
    for (const row of [invalidation, miss].filter((entry) => entry.samples.length === 0)) {
      row.skipped = `unexercised: ${String(error).slice(0, 250)}`
    }
  } finally {
    for (const row of rows) {
      row.context = {
        ...context,
        observations,
        admissionRequests: requests,
        admissionTransitions: JSON.stringify(attempts)
      }
      if (!row.samples.length && !row.skipped) {
        row.skipped = 'required cache transition not observed; unexercised'
      }
    }
  }
}
