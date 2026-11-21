import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, GOOD_PANE, PANE, postHookEvent } from '../../server.test-fixtures'

const stalledOpens = vi.hoisted(
  () => new Map<string, () => Promise<{ close: () => Promise<void> }>>()
)
const emptyRollouts = vi.hoisted(() => new Set<string>())

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) =>
      emptyRollouts.has(String(args[0]))
        ? Promise.resolve({ isFile: () => true, size: 0 })
        : actual.stat(...args),
    open: (...args: Parameters<typeof actual.open>) =>
      stalledOpens.get(String(args[0]))?.() ?? actual.open(...args)
  }
})

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

// #46385: a late prefetch open must leave a slot for other panes even after its hook has returned.
it('excludes polls and prefetches of a stalled rollout through native close while a peer progresses', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
  const dir = mkdtempSync(join(tmpdir(), 'codex-prefetch-stall-'))
  const server = new AgentHookServer()
  const path = join(dir, 'rollout-stalled.jsonl')
  const healthyPath = join(dir, 'rollout-healthy.jsonl')
  const childId = '019fa65f-3144-7151-9c02-cff7a28f316f'
  const spawn = `${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'sub_agent_activity', agent_thread_id: childId, kind: 'started' }
  })}\n`
  const opened = gate()
  const finishOpen = gate()
  const duplicateOpen = gate()
  const closingPrefetch = gate()
  const finishClose = gate()
  let opens = 0
  const post = (paneKey: string, tabId: string, transcriptPath: string) =>
    postHookEvent(
      server,
      buildBody(
        {
          hook_event_name: 'PostToolUse',
          session_id: tabId,
          turn_id: 'turn-1',
          transcript_path: transcriptPath,
          tool_name: 'collaborationspawn_agent'
        },
        { paneKey, tabId }
      ),
      '/hook/codex'
    ).then((response) => response.status)
  const postStalled = () => post(PANE, 'tab-1', path)
  const children = (paneKey: string) =>
    server.getStatusSnapshot().find((row) => row.paneKey === paneKey)?.subagents

  try {
    writeFileSync(path, spawn)
    writeFileSync(healthyPath, spawn)
    // Expose the appended bytes after the first hook without a native watcher wake.
    emptyRollouts.add(path)
    await server.start({ env: 'production' })
    expect(await postStalled()).toBe(204)
    expect(server.getStatusSnapshot()).toMatchObject([{ paneKey: PANE, state: 'working' }])
    emptyRollouts.delete(path)

    stalledOpens.set(path, async () => {
      opens++
      if (opens > 1) {
        duplicateOpen.release()
      }
      opened.release()
      await finishOpen.promise
      return {
        close: async () => {
          closingPrefetch.release()
          await finishClose.promise
        }
      }
    })
    const expiring = postStalled()
    await opened.promise
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await expiring).toBe(204)
    expect(children(PANE)).toBeUndefined()
    expect(opens).toBe(1)

    finishOpen.release()
    await closingPrefetch.promise
    expect(
      await Promise.race([postStalled(), duplicateOpen.promise.then(() => 'duplicate open')])
    ).toBe(204)
    expect(await post(GOOD_PANE, 'tab-good', healthyPath)).toBe(204)
    expect(children(GOOD_PANE)).toMatchObject([{ id: childId, state: 'working' }])
    await vi.advanceTimersByTimeAsync(25_000)
    expect(opens).toBe(1)
    expect(children(PANE)).toBeUndefined()

    stalledOpens.delete(path)
    finishClose.release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(await postStalled()).toBe(204)
    expect(children(PANE)).toMatchObject([{ id: childId, state: 'working' }])
  } finally {
    server.stop()
    stalledOpens.clear()
    emptyRollouts.clear()
    finishClose.release()
    finishOpen.release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  }
})
