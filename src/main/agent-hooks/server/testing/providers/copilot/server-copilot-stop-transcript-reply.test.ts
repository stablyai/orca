import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  TRANSCRIPT_CHUNK_BYTES,
  TRANSCRIPT_MAX_SCAN_BYTES
} from '../../../../../../shared/agent-hook-listener/transcript-reader'
import type * as TranscriptReader from '../../../../../../shared/agent-hook-listener/transcript-reader'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

// Runs once, as the first reply scan returns: the reply Copilot's debounced writer flushes late.
let afterReplyScan: (() => void) | undefined
vi.mock(
  '../../../../../../shared/agent-hook-listener/transcript-reader',
  async (importOriginal) => {
    const actual = await importOriginal<typeof TranscriptReader>()
    return {
      ...actual,
      readLastAssistantFromTranscriptAsync: async (
        ...args: Parameters<typeof actual.readLastAssistantFromTranscriptAsync>
      ) => {
        const text = await actual.readLastAssistantFromTranscriptAsync(...args)
        const append = afterReplyScan
        afterReplyScan = undefined
        append?.()
        return text
      }
    }
  }
)

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
let root: string
let transcriptPath: string
const servers: AgentHookServer[] = []

// Copilot 1.0.114 events.jsonl records, trimmed to the fields Orca reads.
const line = (type: string, data: Record<string, unknown>) =>
  `${JSON.stringify({ type, data, id: `${type}-${Math.random()}` })}\n`
const prompt = (content: string) => line('user.message', { content })
const reply = (content: string) =>
  line('assistant.turn_start', {}) +
  line('assistant.message', { content, toolRequests: [] }) +
  line('assistant.turn_end', {})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-copilot-stop-'))
  transcriptPath = join(root, 'events.jsonl')
  writeFileSync(transcriptPath, line('session.start', { sessionId: SESSION }))
})

afterEach(() => {
  afterReplyScan = undefined
  for (const server of servers.splice(0)) {
    server.stop()
  }
  rmSync(root, { recursive: true, force: true })
})

async function createServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: join(root, 'orca') })
  return server
}

async function hook(server: AgentHookServer, hookEventName: string, extra = {}): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ sessionId: SESSION, ...extra }, { hookEventName }),
    '/hook/copilot'
  )
  expect(response.status).toBe(204)
}

// Copilot's agentStop carries no reply text, only the transcript Orca reads it from.
const stop = (server: AgentHookServer) =>
  hook(server, 'Stop', { transcriptPath, stopReason: 'end_turn', stop_hook_active: false })

const row = (server: AgentHookServer) =>
  server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)

it("waits for the turn's own reply instead of taking the previous turn's", async () => {
  const server = await createServer()
  await hook(server, 'UserPromptSubmit', { prompt: 'Hey' })
  appendFileSync(transcriptPath, prompt('Hey') + reply('Hello there'))
  await stop(server)
  await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('Hello there'))

  await hook(server, 'UserPromptSubmit', { prompt: 'Weather?' })
  appendFileSync(transcriptPath, prompt('Weather?'))
  // Stop fires before Copilot flushes this turn's reply to events.jsonl.
  afterReplyScan = () => appendFileSync(transcriptPath, reply('Today is 53 degrees'))
  await stop(server)

  await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('Today is 53 degrees'))
  expect(row(server)?.state).toBe('done')
})

it("never shows the previous turn's reply on a turn that wrote none", async () => {
  const server = await createServer()
  appendFileSync(transcriptPath, prompt('Hey') + reply('Hello there'))
  await hook(server, 'UserPromptSubmit', { prompt: 'Weather?' })
  appendFileSync(transcriptPath, prompt('Weather?'))
  let scanned = false
  afterReplyScan = () => {
    scanned = true
  }
  await stop(server)

  await vi.waitFor(() => expect(scanned).toBe(true))
  // One macrotask turn lets any restate from that scan land.
  await new Promise((resolve) => setImmediate(resolve))
  expect(row(server)?.state).toBe('done')
  expect(row(server)?.lastAssistantMessage).toBeUndefined()
})

it("takes a Fusion turn's answer, not the narration its commit replays", async () => {
  const server = await createServer()
  await hook(server, 'UserPromptSubmit', { prompt: 'Fix it' })
  appendFileSync(transcriptPath, prompt('Fix it'))
  // Fusion writes the solver's answer after agentStop, then replays the solver's turn.
  afterReplyScan = () =>
    appendFileSync(
      transcriptPath,
      line('assistant.fusion_phase_completed', {
        role: 'solver',
        status: 'succeeded',
        content: 'Fixed it in #12'
      }) +
        line('session.fusion_commit_started', {}) +
        line('assistant.message', { content: "I'll look at the bug", fusion: {} })
    )
  await stop(server)

  await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('Fixed it in #12'))
})

// A whole Fusion replay, larger than one scan reads back, ending in the solver's answer. Replayed
// lines carry the model's encrypted reasoning, so one can outgrow a read chunk.
const fusionReplay = (answer: string) => {
  const replayed = (content: string) =>
    line('assistant.message', {
      content,
      encryptedContent: 'x'.repeat(TRANSCRIPT_CHUNK_BYTES),
      fusion: {}
    })
  const narration = replayed("I'll look at the bug")
  return (
    line('assistant.fusion_phase_completed', {
      role: 'solver',
      status: 'succeeded',
      content: answer
    }) +
    line('session.fusion_commit_started', {}) +
    narration.repeat(Math.ceil(TRANSCRIPT_MAX_SCAN_BYTES / narration.length)) +
    replayed(answer)
  )
}

it("takes a Fusion answer whose replay outgrew the scan before Stop's read", async () => {
  const server = await createServer()
  await hook(server, 'UserPromptSubmit', { prompt: 'Fix it' })
  appendFileSync(
    transcriptPath,
    prompt('Fix it') + fusionReplay('Fixed it in #12') + line('session.fusion_completed', {})
  )
  await stop(server)

  await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('Fixed it in #12'))
})

it("takes an autopilot turn's task_complete summary", async () => {
  const server = await createServer()
  await hook(server, 'UserPromptSubmit', { prompt: 'Ship it' })
  appendFileSync(
    transcriptPath,
    prompt('Ship it') +
      line('assistant.message', { content: '', toolRequests: [{ name: 'task_complete' }] }) +
      line('session.task_complete', { summary: 'Shipped #79', success: true })
  )
  await stop(server)

  await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('Shipped #79'))
})

it("skips a subagent's reply while the main reply is unflushed", async () => {
  const server = await createServer()
  await hook(server, 'UserPromptSubmit', { prompt: 'Find it' })
  const subagent = (type: string, data: Record<string, unknown>) =>
    `${JSON.stringify({ type, data, agentId: 'explore-1' })}\n`
  appendFileSync(
    transcriptPath,
    prompt('Find it') +
      subagent('user.message', { content: 'Search the repo' }) +
      subagent('assistant.message', { content: '<final_answer>\n/src/a.ts', toolRequests: [] }) +
      subagent('session.task_complete', { summary: 'Found /src/a.ts', success: true })
  )
  afterReplyScan = () => appendFileSync(transcriptPath, reply('It is in src/a.ts'))
  await stop(server)

  await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('It is in src/a.ts'))
})

it("takes a Fusion repair turn's answer, not the draft the judge rejected", async () => {
  const server = await createServer()
  const solver = (phaseId: string, content: string) =>
    line('assistant.fusion_phase_completed', {
      phaseId,
      role: 'solver',
      status: 'succeeded',
      content
    })
  await hook(server, 'UserPromptSubmit', { prompt: 'Fix it' })
  appendFileSync(transcriptPath, prompt('Fix it'))
  afterReplyScan = () => appendFileSync(transcriptPath, solver('f:phase:0', 'Draft fix'))
  await stop(server)
  await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('Draft fix'))

  // The judge rejects the draft and hands off to a repair turn with no user.message.
  appendFileSync(
    transcriptPath,
    line('assistant.fusion_phase_completed', {
      role: 'judge',
      status: 'succeeded',
      content: '{}'
    }) + line('session.fusion_handoff', { targetPhaseId: 'f:repair' })
  )
  await hook(server, 'UserPromptSubmit', { prompt: 'HydraFusion Cascade strong-repair handoff.' })
  afterReplyScan = () => appendFileSync(transcriptPath, solver('f:repair', 'Repaired fix'))
  await stop(server)

  await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('Repaired fix'))
})
