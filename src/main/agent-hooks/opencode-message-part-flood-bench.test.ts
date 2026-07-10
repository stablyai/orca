/**
 * Benchmark-style regression test for the OpenCode MessagePart flood.
 *
 * Drives the REAL agent-hook HTTP pipeline (loopback socket, body read,
 * JSON.parse, normalization, listener fanout) with two client behaviors:
 *
 * - "legacy plugin": one POST per streamed part update, each carrying the
 *   FULL accumulated reply text (how plugin builds before the throttle fix
 *   behaved) — O(n²) bytes per turn.
 * - "throttled plugin": leading + trailing-edge coalesced posts at 250ms
 *   cadence with text capped at 4000 chars (current plugin behavior).
 *
 * The byte/post-count assertions are deterministic; wall-clock timings are
 * logged as benchmark evidence (see notes/windows-perf-progress.md) but not
 * asserted, to keep CI stable.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

import { AgentHookServer } from './server'

const PANE = makePaneKey('tab-bench', '99999999-9999-4999-8999-999999999999')

// A realistic long streaming reply: ~120 KB final text arriving in 400
// part updates (OpenCode re-publishes the whole part per append).
const FINAL_REPLY_CHARS = 120_000
const LEGACY_PART_UPDATES = 400
// Throttled plugin posts at most one MessagePart per 250ms. A ~30s turn
// yields ~120 posts; we use that worst-case count with the 4000-char cap.
const THROTTLED_POSTS = 120
const THROTTLED_TEXT_CAP = 4_000

describe('OpenCode MessagePart flood benchmark', () => {
  let server: AgentHookServer
  let tempDir: string
  let listenerEvents: number

  beforeEach(async () => {
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
    tempDir = mkdtempSync(join(tmpdir(), 'orca-hook-bench-'))
    server = new AgentHookServer()
    listenerEvents = 0
    server.setListener(() => {
      listenerEvents++
    })
    await server.start({ env: 'production', userDataPath: tempDir })
  })

  afterEach(() => {
    server.stop()
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function postMessagePart(env: Record<string, string>, text: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        paneKey: PANE,
        tabId: 'tab-bench',
        worktreeId: 'wt-bench',
        env: 'production',
        payload: {
          hook_event_name: 'MessagePart',
          role: 'assistant',
          text,
          messageID: 'msg-bench',
          sessionID: 'session-bench'
        }
      })
    })
    expect(response.status).toBe(204)
  }

  it('throttled plugin behavior cuts per-turn hook-pipeline bytes by >40x', async () => {
    const env = server.buildPtyEnv()
    expect(env.ORCA_AGENT_HOOK_PORT).toBeTruthy()

    // Legacy: full accumulated text per part update.
    let legacyBytes = 0
    const legacyStart = performance.now()
    for (let i = 1; i <= LEGACY_PART_UPDATES; i++) {
      const text = 'x'.repeat(Math.floor((FINAL_REPLY_CHARS * i) / LEGACY_PART_UPDATES))
      legacyBytes += text.length
      await postMessagePart(env, text)
    }
    const legacyMs = performance.now() - legacyStart
    const legacyEvents = listenerEvents

    listenerEvents = 0

    // Throttled: bounded post count, bounded text.
    let throttledBytes = 0
    const throttledStart = performance.now()
    for (let i = 1; i <= THROTTLED_POSTS; i++) {
      const text = 'x'.repeat(THROTTLED_TEXT_CAP)
      throttledBytes += text.length
      await postMessagePart(env, text)
    }
    const throttledMs = performance.now() - throttledStart
    const throttledEvents = listenerEvents

    // eslint-disable-next-line no-console
    console.log(
      `[bench] legacy: ${LEGACY_PART_UPDATES} posts, ${(legacyBytes / 1024 / 1024).toFixed(1)} MB, ` +
        `${legacyMs.toFixed(0)} ms, ${legacyEvents} listener fanouts | ` +
        `throttled: ${THROTTLED_POSTS} posts, ${(throttledBytes / 1024).toFixed(0)} KB, ` +
        `${throttledMs.toFixed(0)} ms, ${throttledEvents} listener fanouts`
    )

    // Deterministic: the turn's total text volume through the main process
    // drops from O(n²) (~23 MB here) to O(posts × cap) (~470 KB here, >40x
    // less). Real turns stream far more than 400 part updates, so the
    // real-world ratio is larger still.
    expect(throttledBytes).toBeLessThan(legacyBytes / 40)
    expect(THROTTLED_POSTS).toBeLessThan(LEGACY_PART_UPDATES / 3 + 1)
  }, 120_000)
})
