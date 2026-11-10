import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, postHookEvent } from '../../server.test-fixtures'

// Captured from a completed Codex CLI 0.159.0 /review; session and turn IDs were replaced.
const reviewRecords = readFileSync(
  new URL('../../../../__fixtures__/codex-review-child-0159.jsonl', import.meta.url),
  'utf8'
)
  .trimEnd()
  .split('\n')
const event = (payload: Record<string, unknown>): string =>
  `${JSON.stringify({ type: 'event_msg', payload })}\n`

describe('Codex turn completion without Stop', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
    })
  })

  let desktop: AgentHookServer
  let directory: string
  let published: (string | undefined)[]

  async function startHost(): Promise<void> {
    directory = mkdtempSync(join(tmpdir(), 'codex-turn-end-'))
    desktop = new AgentHookServer()
    published = []
    desktop.setListener((status) => published.push(status.hookEventName))
    await desktop.start({ env: 'production' })
  }

  async function hook(payload: Record<string, unknown>): Promise<void> {
    const body = buildBody({ session_id: 'root-session', ...payload })
    const response = await postHookEvent(desktop, body, '/hook/codex')
    expect(response.status).toBe(204)
  }

  afterEach(() => {
    desktop.stop()
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  })

  it('settles a /review from its child rollout and leaves later turns working', async () => {
    await startHost()
    const childPath = join(directory, 'review-child.jsonl')
    writeFileSync(childPath, `${reviewRecords[0]}\n`)
    // Review hooks use the root session with child turn/path and emit no agent_id or Stop.
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
    await vi.advanceTimersByTimeAsync(5_000)
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done' }
    })
    // Desktops that predate host-owned turn verdicts still recognize a labelled Stop.
    expect(published.at(-1)).toBe('Stop')

    await hook({ hook_event_name: 'SessionStart', source: 'compact', transcript_path: childPath })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(published.at(-1)).toBe('SessionStart')
    appendFileSync(childPath, event({ type: 'task_started', turn_id: 'next-turn' }))
    await hook({
      ...review,
      turn_id: 'next-turn',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Next'
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({ mainAgent: { state: 'working' } })
    await hook({ ...review, hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({ mainAgent: { state: 'working' } })

    // A Stop consumed before rollout completion must not be rearmed by compaction.
    await hook({ ...review, turn_id: 'next-turn', hook_event_name: 'Stop' })
    await hook({ hook_event_name: 'SessionStart', source: 'compact', transcript_path: childPath })
    appendFileSync(childPath, event({ type: 'task_complete', turn_id: 'next-turn' }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(published.slice(-2)).toEqual(['Stop', 'SessionStart'])
  })
})
