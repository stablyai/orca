import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import type { EnrichedAgentHookEventPayload } from '../../../server-types'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
let root: string
let transcriptPath: string
let server: AgentHookServer | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-stop-text-'))
  transcriptPath = join(root, `${SESSION}.jsonl`)
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All done.' }] } })}\n`
  )
})

afterEach(() => {
  server?.stop()
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

async function hook(payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(
    server!,
    buildBody({ session_id: SESSION, transcript_path: transcriptPath, ...payload })
  )
  expect(response.status).toBe(204)
}

describe('Stop without its reply text', () => {
  it("applies once with the transcript's reply, also behind a child's held permission card", async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath: join(root, 'orca') })
    const rows: EnrichedAgentHookEventPayload[] = []
    server.subscribeEnrichedStatus((row) => rows.push(row))
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    await hook({ hook_event_name: 'Stop' })
    const stops = rows.filter((row) => row.payload.state === 'done')
    expect(stops.map((row) => row.payload.lastAssistantMessage)).toEqual(['All done.'])

    const child = { agent_id: 'agent-child', agent_type: 'general-purpose' }
    const command = { command: 'touch /private/tmp/orca-stop-text-child' }
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    await hook({ hook_event_name: 'SubagentStart', ...child })
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: command, ...child })
    await hook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: command,
      ...child
    })
    await hook({ hook_event_name: 'Stop' })
    const held = server._getStateForTests().lastStatusByPaneKey.get(PANE) as
      | EnrichedAgentHookEventPayload
      | undefined
    expect(held?.toolAgentId).toBe('agent-child')
    expect(held?.acceptedReply?.text).toBe('All done.')
  })
})
