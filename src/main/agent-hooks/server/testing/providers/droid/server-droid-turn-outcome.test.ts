import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
// Droid 1.15.0: the verdict's turnId is the UserPromptSubmit message_id; Stop names the reply instead.
const PROMPT_ID = '4a1f5205-46b5-45ae-8af0-6ceb99e3f670'
let root: string
let transcriptPath: string
const servers: AgentHookServer[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-droid-outcome-'))
  transcriptPath = join(root, `${SESSION}.jsonl`)
  writeFileSync(transcriptPath, '')
})

afterEach(() => {
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

// Droid appends user records after the verdict.
const writeOutcome = (reason: string): void =>
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'agent_turn_outcome', turnId: PROMPT_ID, reason, resultKind: 'text' })}\n` +
      `${JSON.stringify({ type: 'message', id: 'later', message: { role: 'user', content: [] } })}\n`
  )

async function submit(server: AgentHookServer): Promise<void> {
  await hook(server, { hook_event_name: 'UserPromptSubmit', message_id: PROMPT_ID, prompt: 'go' })
}

const stop = (server: AgentHookServer) =>
  hook(server, { hook_event_name: 'Stop', message_id: 'reply-id', last_assistant_message: 'Done.' })

async function expectOutcome(server: AgentHookServer, outcome: string): Promise<void> {
  await vi.waitFor(() => expect(row(server)?.mainAgent?.outcome).toBe(outcome), { timeout: 5_000 })
  expect(row(server)?.state).toBe('done')
}

describe('Droid turn outcome from the transcript', () => {
  it('reports a permission prompt cancel as a cancelled turn', async () => {
    const server = await createServer()
    await submit(server)
    writeOutcome('cancelled')
    await stop(server)
    await expectOutcome(server, 'cancellation')
  })

  it.each(['model_provider_unreachable', 'model_authentication_failed', 'prompt_rejected'])(
    'reports %s as a failed turn',
    async (reason) => {
      const server = await createServer()
      await submit(server)
      writeOutcome(reason)
      await stop(server)
      await expectOutcome(server, 'failure')
    }
  )

  it('reports a user stop (idle notification) as a cancelled turn', async () => {
    const server = await createServer()
    await submit(server)
    writeOutcome('cancelled')
    await hook(server, {
      hook_event_name: 'Notification',
      message: 'Agent stopped by user and is waiting for input',
      notification_type: 'idle_prompt'
    })
    await expectOutcome(server, 'cancellation')
  })

  it('marks the stopped turn failed once the verdict lands after Stop', async () => {
    const server = await createServer()
    await submit(server)
    await stop(server)
    expect(row(server)?.mainAgent?.outcome).toBeUndefined()

    writeOutcome('model_provider_unreachable')
    await expectOutcome(server, 'failure')
  })

  it('does not carry a verdict into work that started without a prompt', async () => {
    const server = await createServer()
    await submit(server)
    writeOutcome('model_provider_unreachable')
    await stop(server)
    await expectOutcome(server, 'failure')

    await hook(server, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' }
    })
    await stop(server)
    expect(row(server)?.mainAgent?.outcome).toBeUndefined()
  })
})
