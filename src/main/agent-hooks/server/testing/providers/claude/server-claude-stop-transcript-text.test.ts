import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'
import type * as TranscriptReader from '../../../../../../shared/agent-hook-listener/transcript-reader'

const reads = vi.hoisted(() => {
  const pending: ((text: string | undefined) => void)[] = []
  return pending
})
vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../../../../shared/agent-hook-listener/transcript-reader', async (original) => ({
  ...(await original<typeof TranscriptReader>()),
  readLastAssistantFromTranscriptAsync: () =>
    new Promise<string | undefined>((resolve) => reads.push(resolve))
}))

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
let root: string
let transcriptPath: string
const servers: AgentHookServer[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-stop-text-'))
  transcriptPath = join(root, `${SESSION}.jsonl`)
  // A real reply the old inline scan would have put on the Stop row at once.
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All done.' }] } })}\n`
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    server.stop()
  }
  reads.length = 0
  rmSync(root, { recursive: true, force: true })
})

async function createServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: join(root, 'orca') })
  return server
}

async function hook(server: AgentHookServer, payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ session_id: SESSION, transcript_path: transcriptPath, ...payload })
  )
  expect(response.status).toBe(204)
}

const row = (server: AgentHookServer) =>
  server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)

describe('Stop without its text', () => {
  it('applies at once, then gains the transcript reply on the same turn', async () => {
    const server = await createServer()
    await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    await hook(server, { hook_event_name: 'Stop' })

    const stopped = row(server)
    expect(stopped?.state).toBe('done')
    expect(stopped?.lastAssistantMessage).toBeUndefined()

    await vi.waitFor(() => expect(reads).toHaveLength(1))
    reads[0]!('All done.')
    await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('All done.'))
    expect(row(server)?.state).toBe('done')
    expect(row(server)?.stateStartedAt).toBe(stopped?.stateStartedAt)
  })

  it('drops the reply when a newer turn with the same prompt arrived first', async () => {
    const server = await createServer()
    await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    await hook(server, { hook_event_name: 'Stop' })
    await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    const newer = row(server)
    expect(newer?.state).toBe('working')

    await vi.waitFor(() => expect(reads).toHaveLength(1))
    reads[0]!('All done.')
    // The read settles in a microtask; one macrotask turn lets any late apply land.
    await new Promise((resolve) => setImmediate(resolve))
    expect(row(server)).toEqual(newer)
  })

  it("keeps an earlier turn's reply off a newer one stamped in the same millisecond", async () => {
    const server = await createServer()
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    await hook(server, { hook_event_name: 'Stop' })
    await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    await hook(server, { hook_event_name: 'Stop' })

    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[0]!('Earlier turn.')
    await new Promise((resolve) => setImmediate(resolve))
    expect(row(server)?.lastAssistantMessage).toBeUndefined()
    reads[1]!('All done.')
    await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('All done.'))
  })
})
