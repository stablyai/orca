import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DroidTurnOutcome from '../../../../../../shared/agent-hook-listener/providers/droid/droid-turn-outcome'
import type * as TranscriptReader from '../../../../../../shared/agent-hook-listener/transcript-reader'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

// Runs once, as the first reply scan returns: lets a test append what Droid flushes between scans.
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

// While set, every verdict read waits on it: a test can stall the verdict I/O.
let verdictReadGate: Promise<void> | undefined
vi.mock(
  '../../../../../../shared/agent-hook-listener/providers/droid/droid-turn-outcome',
  async (importOriginal) => {
    const actual = await importOriginal<typeof DroidTurnOutcome>()
    return {
      ...actual,
      readDroidTurnVerdictAsync: async (
        ...args: Parameters<typeof actual.readDroidTurnVerdictAsync>
      ) => {
        await verdictReadGate
        return actual.readDroidTurnVerdictAsync(...args)
      }
    }
  }
)

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
let root: string
let transcriptPath: string
const servers: AgentHookServer[] = []

// Records as Droid persists them: the Stop hook's own record lands before the turn's outcome.
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`
const prompt = (id: string) =>
  line({ type: 'message', id, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } })
const reply = line({
  type: 'message',
  id: 'reply',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Running mkdir.' }] }
})
const stopHookRecord = line({
  type: 'message',
  id: 'stop-hook',
  message: { role: 'user', content: [], visibility: 'user_only', hookEventName: 'Stop' }
})
const outcome = (turnId: string, reason: string) =>
  line({ type: 'agent_turn_outcome', turnId, reason, resultKind: 'text' })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-droid-outcome-'))
  transcriptPath = join(root, `${SESSION}.jsonl`)
  writeFileSync(transcriptPath, line({ type: 'session_start', id: SESSION, cwd: root }))
})

afterEach(() => {
  afterReplyScan = undefined
  verdictReadGate = undefined
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

async function hook(server: AgentHookServer, payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ session_id: SESSION, transcript_path: transcriptPath, ...payload }),
    '/hook/droid'
  )
  expect(response.status).toBe(204)
}

const row = (server: AgentHookServer) =>
  server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)

describe('Droid turn outcome', () => {
  it('marks a turn cancelled at a permission prompt as cancelled', async () => {
    const server = await createServer()
    await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    appendFileSync(transcriptPath, prompt('turn-1') + reply)
    await hook(server, { hook_event_name: 'Stop' })
    appendFileSync(transcriptPath, stopHookRecord)
    // The reply lands without waiting for the verdict, which Droid appends after its Stop hook returned.
    await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('Running mkdir.'))
    expect(row(server)?.mainAgent).toBeUndefined()
    appendFileSync(transcriptPath, outcome('turn-1', 'cancelled'))

    await vi.waitFor(() => expect(row(server)?.mainAgent?.outcome).toBe('cancellation'))
    expect(row(server)).toMatchObject({
      state: 'done',
      interrupted: true,
      lastAssistantMessage: 'Running mkdir.'
    })
  })

  it('marks a failed turn that wrote no reply as failed', async () => {
    const server = await createServer()
    await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    appendFileSync(transcriptPath, prompt('turn-1'))
    await hook(server, { hook_event_name: 'Stop' })
    const stoppedAt = row(server)?.stateStartedAt
    appendFileSync(transcriptPath, stopHookRecord + outcome('turn-1', 'model_provider_unreachable'))

    await vi.waitFor(() => expect(row(server)?.mainAgent?.outcome).toBe('failure'))
    expect(row(server)?.mainAgent?.stateStartedAt).toBe(stoppedAt)
    expect(row(server)?.lastAssistantMessage).toBeUndefined()
    expect(row(server)?.interrupted).toBeUndefined()
  })

  it('publishes the reply while the verdict read is stalled', async () => {
    const stalled = Promise.withResolvers<void>()
    verdictReadGate = stalled.promise
    try {
      const server = await createServer()
      await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      appendFileSync(transcriptPath, prompt('turn-1') + reply)
      await hook(server, { hook_event_name: 'Stop' })

      await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('Running mkdir.'))
      appendFileSync(transcriptPath, stopHookRecord + outcome('turn-1', 'cancelled'))
      stalled.resolve()
      await vi.waitFor(() => expect(row(server)?.mainAgent?.outcome).toBe('cancellation'))
      expect(row(server)?.lastAssistantMessage).toBe('Running mkdir.')
    } finally {
      stalled.resolve()
    }
  })

  it('reads a verdict that lands after the reply retries ran out', async () => {
    const server = await createServer()
    await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    appendFileSync(transcriptPath, prompt('turn-1') + reply)
    await hook(server, { hook_event_name: 'Stop' })
    await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('Running mkdir.'))
    // A slower sibling Stop hook holds Droid's outcome past the reply's 5 x 50 ms retries.
    await new Promise((resolve) => setTimeout(resolve, 400))
    appendFileSync(transcriptPath, stopHookRecord + outcome('turn-1', 'cancelled'))

    await vi.waitFor(() => expect(row(server)?.mainAgent?.outcome).toBe('cancellation'), {
      timeout: 2_000
    })
  })

  it.each([
    ['cancelled', 'cancellation'],
    ['completed', undefined]
  ])('keeps reading the reply when a %s verdict lands first', async (reason, verdict) => {
    const server = await createServer()
    await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    appendFileSync(transcriptPath, prompt('turn-1'))
    // The reply, Stop record and outcome flush after the reply scan but before the verdict scan.
    afterReplyScan = () => {
      appendFileSync(transcriptPath, reply + stopHookRecord + outcome('turn-1', reason))
    }
    await hook(server, { hook_event_name: 'Stop' })

    await vi.waitFor(() => expect(row(server)?.lastAssistantMessage).toBe('Running mkdir.'))
    expect(row(server)?.mainAgent?.outcome).toBe(verdict)
  })

  it('reads the verdict of a Stop that carried its reply', async () => {
    const server = await createServer()
    await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    appendFileSync(transcriptPath, prompt('turn-1'))
    await hook(server, { hook_event_name: 'Stop', last_assistant_message: 'Partial reply.' })
    appendFileSync(transcriptPath, stopHookRecord + outcome('turn-1', 'cancelled'))

    await vi.waitFor(() => expect(row(server)?.mainAgent?.outcome).toBe('cancellation'))
    expect(row(server)).toMatchObject({ interrupted: true, lastAssistantMessage: 'Partial reply.' })
  })

  it('marks a turn the user stopped while working as cancelled', async () => {
    const server = await createServer()
    await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await hook(server, {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Agent is waiting for input'
    })

    expect(row(server)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})
