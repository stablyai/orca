import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { buildBody, postHookEvent } from '../../server.test-fixtures'
import type * as TranscriptPoll from '../../../../../../shared/agent-hook-listener/providers/antigravity/antigravity-transcript-poll'

const reads = vi.hoisted(() => ({
  count: 0,
  finished: 0,
  released: Promise.resolve(),
  release: (): void => {}
}))

vi.mock(
  '../../../../../../shared/agent-hook-listener/providers/antigravity/antigravity-transcript-poll',
  async (importOriginal) => {
    const actual = await importOriginal<typeof TranscriptPoll>()
    return {
      ...actual,
      readAntigravityTranscriptPoll: async (
        ...args: Parameters<typeof actual.readAntigravityTranscriptPoll>
      ) => {
        reads.count++
        await reads.released
        const result = await actual.readAntigravityTranscriptPoll(...args)
        reads.finished++
        return result
      }
    }
  }
)

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  reads.count = 0
  reads.finished = 0
  reads.released = new Promise((resolve) => (reads.release = resolve))
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-poll-teardown-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

it.each([10, 100])(
  'schedules no poll for %s subagent panes after status hooks are disabled mid-read',
  async (panes) => {
    for (let i = 0; i < panes; i++) {
      const leaf = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
      const overrides = { paneKey: makePaneKey(`tab-${i}`, leaf), tabId: `tab-${i}` }
      const logs = join(dir, `root-${i}`, '.system_generated', 'logs')
      mkdirSync(logs, { recursive: true })
      const transcriptPath = join(logs, 'transcript.jsonl')
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT' })}\n`
      )
      const root = { conversationId: `root-${i}`, lastUserInput: 'Task', transcriptPath }
      const child = { conversationId: `child-${i}`, lastUserInput: '' }
      for (const [hookEventName, payload] of [
        ['PreInvocation', root],
        ['PreInvocation', child]
      ] as const) {
        const body = buildBody(payload, { ...overrides, hookEventName })
        expect((await postHookEvent(server, body, '/hook/antigravity')).status).toBe(204)
      }
    }
    await vi.waitFor(() => expect(reads.count).toBe(panes), { timeout: 10000 })
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    server.setStatusHooksEnabled(false)
    reads.release()
    await vi.waitFor(() => expect(reads.finished).toBe(panes), { timeout: 10000 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(reads.count).toBe(panes)
  }
)
