import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Diagram } from '../types'
import { splitBlocks, classify } from './blocks'
import type { Script } from './blocks'
import { run } from './render-process'

// This address is also declared by register.tsx so each module can be scanned.
const diagrams = atom({ plugin: 'reply-media', key: 'diagrams' } as const, {})

// Node/MathJax cold starts on a shared devbox can outlast five seconds.
// Keep a finite bound and retry only a killed, transient timeout once.
const RENDER_TIMEOUT_MS = 30_000
const pendingRenders = new Map<string, Promise<void>>()

export function scheduleRender(
  $: EngineInterface,
  text: string,
  drawn: ReadonlySet<Script>,
  isForced = false,
  onFailure?: () => void
) {
  $.clock.after(0, async () => {
    try {
      await render($, text, drawn, isForced)
    } catch (error) {
      onFailure?.()
      $.ui.toast(`Media preview failed: ${String(error)}`)
    }
  })
}

export async function renderResumed(
  $: EngineInterface,
  replies: readonly string[],
  drawn: ReadonlySet<Script>
) {
  if (replies.length === 0) {
    return
  }
  const deadline = (await $.clock.now()) + RENDER_TIMEOUT_MS
  let budgetTimer: { cancel: () => void } | undefined
  const budget = new Promise<void>((resolve) => {
    budgetTimer = $.clock.after(RENDER_TIMEOUT_MS, resolve)
  })
  try {
    await Promise.race([
      (async () => {
        for (const text of replies) {
          if ((await $.clock.now()) >= deadline) {
            break
          }
          try {
            await render($, text, drawn, true, deadline)
          } catch (error) {
            $.ui.toast(`Media preview failed: ${String(error)}`)
          }
        }
      })(),
      budget
    ])
  } finally {
    budgetTimer?.cancel()
  }
}

/**
 * Renders each block of `text` that has no outcome yet, and records it;
 * `isForced` renders the ones that have an outcome too.
 */
export async function render(
  $: EngineInterface,
  text: string,
  drawn: ReadonlySet<Script>,
  isForced = false,
  deadline?: number
) {
  const cwd = await $.session.cwd()

  for (const [index, block] of splitBlocks(text).entries()) {
    if (index % 2 === 0) {
      continue
    }
    const job = classify(block, drawn)
    // An image or a video is read again each time it is shown: the file
    // behind an unchanged path may be a new one.
    const isFile = job?.script === 'picture' || job?.script === 'video'
    const known = await read($, diagrams)
    if (job === undefined || (!isFile && !isForced && known[block] && !('error' in known[block]))) {
      continue
    }
    if (deadline !== undefined && (await $.clock.now()) >= deadline) {
      return
    }

    // Append, resume and a retry button may request the same block together.
    // Share that render instead of racing writers or multiplying cold starts.
    const key = JSON.stringify([cwd, block])
    const pending = pendingRenders.get(key)
    if (pending) {
      await pending
      continue
    }
    const task = (async () => {
      const remaining =
        deadline === undefined ? RENDER_TIMEOUT_MS : deadline - (await $.clock.now())
      if (remaining <= 0) {
        return
      }
      const init = { stdin: job.source, timeoutMs: Math.min(RENDER_TIMEOUT_MS, remaining), cwd }
      let outcome = await run<Diagram>($, [job.script], init)
      if ('error' in outcome && /aborted: still running after \d+ms/.test(outcome.error)) {
        const retryBudget =
          deadline === undefined ? RENDER_TIMEOUT_MS : deadline - (await $.clock.now())
        if (retryBudget > 0) {
          outcome = await run<Diagram>($, [job.script], {
            ...init,
            timeoutMs: Math.min(RENDER_TIMEOUT_MS, retryBudget)
          })
        }
      }
      await update($, diagrams, (all) => ({ ...all, [block]: outcome }))
    })()
    pendingRenders.set(key, task)
    try {
      await task
    } finally {
      pendingRenders.delete(key)
    }
  }
}
