import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { buildBody, postHookEvent } from '../../server.test-fixtures'
import type * as BrainMetadata from '../../../../../../shared/agent-hook-listener/providers/antigravity/antigravity-brain-metadata'
import type * as BoundedFileReader from '../../../../../../shared/file-content/node-bounded-file-reader'

const reads = vi.hoisted(() => ({
  members: 0,
  finished: 0,
  descriptors: 0,
  files: 0,
  released: Promise.resolve(),
  release: (): void => {}
}))

vi.mock(
  '../../../../../../shared/agent-hook-listener/providers/antigravity/antigravity-brain-metadata',
  async (importOriginal) => {
    const actual = await importOriginal<typeof BrainMetadata>()
    return {
      ...actual,
      readAntigravitySwarmMembers: async (
        ...args: Parameters<typeof actual.readAntigravitySwarmMembers>
      ) => {
        reads.members++
        await reads.released
        const result = await actual.readAntigravitySwarmMembers(...args)
        reads.finished++
        return result
      },
      readAntigravityChildMetadata: (
        ...args: Parameters<typeof actual.readAntigravityChildMetadata>
      ) => {
        reads.descriptors++
        return actual.readAntigravityChildMetadata(...args)
      }
    }
  }
)

vi.mock(
  '../../../../../../shared/file-content/node-bounded-file-reader',
  async (importOriginal) => {
    const actual = await importOriginal<typeof BoundedFileReader>()
    return {
      ...actual,
      readNodeFileWithinLimit: (...args: Parameters<typeof actual.readNodeFileWithinLimit>) => {
        reads.files++
        return actual.readNodeFileWithinLimit(...args)
      }
    }
  }
)

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  reads.members = 0
  reads.finished = 0
  reads.descriptors = 0
  reads.files = 0
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
  'starts no transcript read for %s subagent panes after status hooks are disabled mid-read',
  async (panes) => {
    for (let i = 0; i < panes; i++) {
      const leaf = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
      const overrides = { paneKey: makePaneKey(`tab-${i}`, leaf), tabId: `tab-${i}` }
      const logs = join(dir, `root-${i}`, '.system_generated', 'logs')
      mkdirSync(logs, { recursive: true })
      mkdirSync(join(dir, `root-${i}`, '.system_generated', 'swarm'))
      writeFileSync(
        join(dir, `root-${i}`, '.system_generated', 'swarm', 'members.json'),
        JSON.stringify({ members: {} })
      )
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
    await vi.waitFor(() => expect(reads.members).toBe(panes), { timeout: 10000 })
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    server.setStatusHooksEnabled(false)
    reads.release()
    await vi.waitFor(() => expect(reads.finished).toBe(panes), { timeout: 10000 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(reads).toMatchObject({ members: panes, descriptors: 0, files: 0 })
  }
)
