import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'
import type * as ReplyModel from '../../../../../../shared/agent-hook-listener/providers/claude/transcripts/claude-transcript-reply-model'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const held = vi.hoisted(() => ({
  active: false,
  pending: [] as ((model: string | null | undefined) => void)[]
}))
vi.mock(
  '../../../../../../shared/agent-hook-listener/providers/claude/transcripts/claude-transcript-reply-model',
  async (original) => {
    const actual = await original<typeof ReplyModel>()
    return {
      ...actual,
      readClaudeTranscriptReplyModelAsync: (
        ...args: Parameters<typeof actual.readClaudeTranscriptReplyModelAsync>
      ) =>
        held.active
          ? new Promise<string | null | undefined>((resolve) => held.pending.push(resolve))
          : actual.readClaudeTranscriptReplyModelAsync(...args)
    }
  }
)

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
let root: string
let transcriptPath: string
let server: AgentHookServer

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-stop-reply-model-'))
  transcriptPath = join(root, `${SESSION}.jsonl`)
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: join(root, 'orca') })
})

afterEach(() => {
  held.active = false
  held.pending.length = 0
  server.stop()
  rmSync(root, { recursive: true, force: true })
})

const assistant = (model: string, text: string) => ({
  type: 'assistant',
  isSidechain: false,
  message: { role: 'assistant', model, content: [{ type: 'text', text }] }
})
const user = (content: string) => ({
  type: 'user',
  isSidechain: false,
  message: { role: 'user', content }
})

function writeTranscript(records: Record<string, unknown>[]): void {
  writeFileSync(transcriptPath, records.map((record) => `${JSON.stringify(record)}\n`).join(''))
}

async function hook(payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ session_id: SESSION, transcript_path: transcriptPath, ...payload })
  )
  expect(response.status).toBe(204)
}

async function statusLine(modelId: string): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/statusline/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Connection: 'close',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: new URLSearchParams({
      paneKey: PANE,
      payload: JSON.stringify({
        session_id: SESSION,
        model: { id: modelId, display_name: 'Model' },
        rate_limits: { five_hour: { used_percentage: 1 } }
      })
    })
  })
  expect(response.status).toBe(204)
}

const model = (): string | undefined =>
  server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)?.model

// API-key, Bedrock and Vertex logins, and a user's own statusLine, send no statusline post.
it('takes a /model switch from the Stop reply when no statusline post arrives', async () => {
  await hook({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' })
  writeTranscript([
    user('first'),
    assistant('claude-opus-5-5', 'One.'),
    user('<local-command-stdout>Set model to Fable 5.2</local-command-stdout>'),
    user('second'),
    assistant('claude-fable-5-2', 'Two.')
  ])
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'second' })
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'Two.' })

  await vi.waitFor(() => expect(model()).toBe('claude-fable-5-2'))
  // Later hooks carry no model; they must not bring the start model back.
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'third' })
  expect(model()).toBe('claude-fable-5-2')
})

it('keeps a statusline model reported while the Stop reply was being read', async () => {
  await hook({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' })
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'first' })
  writeTranscript([user('first'), assistant('claude-opus-5-5', 'One.')])
  held.active = true
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'One.' })
  await vi.waitFor(() => expect(held.pending).toHaveLength(1))

  // /model right after the turn: the statusline reports it before the Stop's read lands.
  await statusLine('claude-fable-5-2')
  expect(model()).toBe('claude-fable-5-2')
  held.pending[0]!('claude-opus-5-5')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  expect(model()).toBe('claude-fable-5-2')
})
