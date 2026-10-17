import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

// Captured from a completed Codex CLI 0.159.0 /review; session and turn IDs were replaced.
const reviewRecords = readFileSync(
  new URL('./__fixtures__/codex-review-child-0159.jsonl', import.meta.url),
  'utf8'
)
  .trimEnd()
  .split('\n')
const event = (payload: Record<string, unknown>): string =>
  `${JSON.stringify({ type: 'event_msg', payload })}\n`
const settle = (ms = 1_200) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Codex turn completion without Stop', () => {
  let desktop: AgentHookServer
  let relay: RelayAgentHookServer | undefined
  let directory: string
  let published: (string | undefined)[]

  async function startHost(relayed: boolean): Promise<void> {
    directory = mkdtempSync(join(tmpdir(), 'codex-turn-end-'))
    desktop = new AgentHookServer()
    published = []
    desktop.setListener((status) => published.push(status.hookEventName))
    if (!relayed) {
      await desktop.start({ env: 'production' })
      return
    }
    relay = new RelayAgentHookServer({
      endpointDir: directory,
      forward: (envelope) => desktop.ingestRemote(envelope, 'ssh-connection')
    })
    await relay.start()
  }

  async function hook(payload: Record<string, unknown>): Promise<void> {
    const body = buildBody({ session_id: 'root-session', ...payload })
    const coordinates = relay?.getCoordinates()
    const response = coordinates
      ? await fetch(`http://127.0.0.1:${coordinates.port}/hook/codex`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': coordinates.token
          },
          body: JSON.stringify(body)
        })
      : await postHookEvent(desktop, body, '/hook/codex')
    expect(response.status).toBe(204)
  }

  afterEach(() => {
    desktop.stop()
    relay?.stop()
    relay = undefined
    rmSync(directory, { recursive: true, force: true })
  })

  it('settles a /review from its child rollout and leaves later turns working', async () => {
    await startHost(false)
    const childPath = join(directory, 'review-child.jsonl')
    writeFileSync(childPath, `${reviewRecords[0]}\n`)
    // Real review hooks carry the root session ID and child turn/path, with no agent_id or Stop.
    const review = { transcript_path: childPath, turn_id: 'child-turn' }
    await hook({ ...review, hook_event_name: 'UserPromptSubmit', prompt: 'Review changes' })
    for (const hookEventName of ['PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUse']) {
      await hook({ ...review, hook_event_name: hookEventName, tool_name: 'Bash' })
    }
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      providerSession: { id: 'root-session', transcriptPath: childPath }
    })

    appendFileSync(childPath, `${reviewRecords[1]}\n`)
    await vi.waitFor(
      () =>
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          mainAgent: { state: 'done' }
        }),
      { timeout: 3_000 }
    )
    // Desktops that predate host-owned turn verdicts still recognize a labelled Stop.
    expect(published.at(-1)).toBe('Stop')

    // Neither a compaction queued before the next prompt nor a newer turn replays the review's end.
    await hook({ hook_event_name: 'SessionStart', source: 'compact', transcript_path: childPath })
    await settle()
    expect(published.at(-1)).toBe('SessionStart')
    appendFileSync(childPath, event({ type: 'task_started', turn_id: 'next-turn' }))
    await hook({
      ...review,
      turn_id: 'next-turn',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Next'
    })
    await settle()
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({ mainAgent: { state: 'working' } })
    // A delayed hook from the review's ended turn does not end the newer turn.
    await hook({ ...review, hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({ mainAgent: { state: 'working' } })

    // A real Stop that lands before its rollout end, then a compaction, never rearms that turn.
    await hook({ ...review, turn_id: 'next-turn', hook_event_name: 'Stop' })
    await hook({ hook_event_name: 'SessionStart', source: 'compact', transcript_path: childPath })
    appendFileSync(childPath, event({ type: 'task_complete', turn_id: 'next-turn' }))
    await settle()
    expect(published.slice(-2)).toEqual(['Stop', 'SessionStart'])
  })

  it.each([
    ['locally', 'in an earlier poll', false, true],
    ['locally', 'in the same poll', false, false],
    ['through a relay', 'in an earlier poll', true, true]
  ])(
    'settles a failed turn %s after a child finished %s',
    async (_, __, relayed, separatePolls) => {
      await startHost(relayed)
      const day = join(directory, '2026', '10', '16')
      mkdirSync(day, { recursive: true })
      const rootPath = join(day, 'rollout-2026-10-16T00-00-00-root.jsonl')
      const childId = '0199aaaa-bbbb-cccc-dddd-eeeeffff0001'
      const childPath = join(day, `rollout-2026-10-16T00-00-01-${childId}.jsonl`)
      const root = { transcript_path: rootPath, turn_id: 'root-turn' }
      writeFileSync(rootPath, event({ type: 'task_started', turn_id: 'root-turn' }))
      await hook({ ...root, hook_event_name: 'UserPromptSubmit', prompt: 'Do the task' })
      const started = { agent_thread_id: childId, kind: 'started', occurred_at_ms: Date.now() }
      appendFileSync(rootPath, event({ type: 'sub_agent_activity', ...started }))
      writeFileSync(childPath, event({ type: 'task_started', turn_id: 'child-turn' }))
      await hook({ ...root, hook_event_name: 'PostToolUse', tool_name: 'spawn_agent' })

      appendFileSync(childPath, event({ type: 'task_complete', turn_id: 'child-turn' }))
      if (separatePolls) {
        await settle()
      }
      const failure = { error: { message: 'usage limit' } }
      appendFileSync(rootPath, event({ type: 'task_complete', turn_id: 'root-turn', ...failure }))
      await vi.waitFor(
        () =>
          expect(desktop.getStatusSnapshot()[0]).toMatchObject({
            state: 'done',
            mainAgent: { state: 'done', outcome: 'failure' }
          }),
        { timeout: 3_000 }
      )
      // Desktops derive a labelled Stop's outcome as success, so a failure goes out unlabelled.
      expect(published.at(-1)).toBeUndefined()
    }
  )
})
