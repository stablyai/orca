import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

// Only identified turns or verified Stop revisions mint an end; repeats and ambiguity never mint another.
describe('the host-stamped turn end', () => {
  let server: AgentHookServer
  let directory: string

  beforeEach(async () => {
    _internals.resetCachesForTests()
    directory = mkdtempSync(join(tmpdir(), 'orca-turn-ended-at-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath: directory })
  })

  afterEach(() => {
    server.stop()
    rmSync(directory, { recursive: true, force: true })
  })

  async function post(payload: Record<string, unknown>, path = '/hook/claude'): Promise<void> {
    expect((await postHookEvent(server, buildBody(payload), path)).status).toBe(204)
    // Separate host timestamps by advancing real time between events.
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const row = () => server.getStatusSnapshot()[0]

  it('mints identified ends and revisions; an unproven repeat or a lost opening is ambiguous', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Lint the repo' })
    await post({ hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    const first = row()
    expect(first).toMatchObject({ turnEndDisposition: 'identified' })

    // Without a turn id, a repeat can't be told from a turn whose prompt hook never arrived.
    await post({ hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    await post({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    expect(row()).toMatchObject({
      turnEndedAt: first?.turnEndedAt,
      turnEndDisposition: 'ambiguous'
    })

    // A blocking Stop hook made Claude continue; the same text still ends a new attempt.
    await post({ hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'Done.' })
    expect(row()?.turnEndedAt).toBeGreaterThan(first!.turnEndedAt!)
    expect(row()).toMatchObject({ turnEndDisposition: 'identified' })
    expect(row()?.stateStartedAt).toBe(first?.stateStartedAt)

    // The next prompt's hook was lost: its tool work and Stop reuse no earlier end.
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    await post({ hook_event_name: 'Stop', last_assistant_message: 'Second.' })
    expect(row()).toMatchObject({ state: 'done', turnEndDisposition: 'ambiguous' })
    expect(row()).not.toHaveProperty('turnEndedAt')

    // A cancel Orca inferred from Ctrl+C ends the turn, so the turn's late Stop is no second end.
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' })
    const working = row()!
    expect(
      server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: working.receivedAt,
        baselineStateStartedAt: working.stateStartedAt,
        baselinePrompt: working.prompt,
        baselineAgentType: 'claude',
        intent: 'ctrl-c'
      })
    ).toBe(true)
    const cancelled = row()
    await post({ hook_event_name: 'Stop', last_assistant_message: 'Fixed.' })
    expect(row()).toMatchObject({
      state: 'done',
      stateStartedAt: cancelled?.stateStartedAt,
      turnEndDisposition: 'ambiguous'
    })
    expect(row()).not.toHaveProperty('turnEndedAt')
  })

  it('keeps a Grok end across a session reset and the idle reminder that follows it', async () => {
    const turn = { sessionId: 'session-1', promptId: 'prompt-1' }
    await post({ hookEventName: 'user_prompt_submit', ...turn, prompt: 'go' }, '/hook/grok')
    await post({ hookEventName: 'stop', ...turn, lastAssistantMessage: 'Shipped.' }, '/hook/grok')
    const ended = row()?.turnEndedAt
    expect(ended).toEqual(expect.any(Number))

    await post({ hookEventName: 'session_start', sessionId: 'session-2' }, '/hook/grok')
    await post(
      { hookEventName: 'notification', sessionId: 'session-2', notificationType: 'idle_prompt' },
      '/hook/grok'
    )
    expect(row()).toMatchObject({
      state: 'done',
      turnEndedAt: ended,
      turnEndDisposition: 'identified'
    })
  })

  it('ends Codex turns by turn id, with or without a prompt hook in between', async () => {
    const codex = (payload: Record<string, unknown>) => post(payload, '/hook/codex')
    await codex({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-a', prompt: 'Plan it' })
    await codex({ hook_event_name: 'Stop', turn_id: 'turn-a', last_assistant_message: 'Planned.' })
    const first = row()?.turnEndedAt
    expect(first).toEqual(expect.any(Number))

    // A known turn ID without continuation proves duplicate Stop even after tool work reopens the row.
    await codex({ hook_event_name: 'Stop', turn_id: 'turn-a', last_assistant_message: 'Planned.' })
    await codex({ hook_event_name: 'PreToolUse', turn_id: 'turn-a', tool_name: 'Bash' })
    await codex({ hook_event_name: 'Stop', turn_id: 'turn-a', last_assistant_message: 'Planned.' })
    expect(row()).toMatchObject({
      state: 'done',
      turnEndedAt: first,
      turnEndDisposition: 'identified'
    })

    // A turn woken by agent mail runs no prompt hook and stays `done`; its own turn id ends it.
    await codex({ hook_event_name: 'Stop', turn_id: 'turn-b', last_assistant_message: 'Replied.' })
    const mailTurn = row()?.turnEndedAt
    expect(mailTurn).toBeGreaterThan(first!)

    // Codex re-fires Stop with the flag when a blocking Stop hook continues the same turn.
    await codex({ hook_event_name: 'Stop', turn_id: 'turn-b', stop_hook_active: true })
    expect(row()?.turnEndedAt).toBeGreaterThan(mailTurn!)
    expect(row()).not.toHaveProperty('hostTurn')
  })

  it('ends Command Code turns by transcript position; a same-position repeat is ambiguous', async () => {
    const transcriptPath = join(directory, 'command-code.jsonl')
    const prompt = `${JSON.stringify({ role: 'user', content: 'Status?' })}\n`
    const stop = { hook_event_name: 'Stop', transcript_path: transcriptPath }
    writeFileSync(transcriptPath, prompt)
    await post(stop, '/hook/command-code')
    const first = row()?.turnEndedAt
    expect(row()).toMatchObject({ turnEndDisposition: 'identified' })
    // Its key alone doesn't prove a repeat (no verified continuation flag).
    await post(stop, '/hook/command-code')
    expect(row()).toMatchObject({ turnEndedAt: first, turnEndDisposition: 'ambiguous' })

    writeFileSync(transcriptPath, prompt.repeat(2))
    await post(stop, '/hook/command-code')
    expect(row()?.turnEndedAt).toBeGreaterThan(first!)
    expect(row()).toMatchObject({ turnEndDisposition: 'identified' })
  })

  it('restates the end when a result retry adds the late transcript text', async () => {
    const transcriptPath = join(directory, 'events.jsonl')
    writeFileSync(transcriptPath, '')
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' }, '/hook/copilot')
    // The Stop's text isn't flushed yet; its retry re-reads the same Stop body.
    const stop = { hook_event_name: 'Stop', transcript_path: transcriptPath }
    await post(stop, '/hook/copilot')
    const ended = row()?.turnEndedAt
    expect(row()).toMatchObject({ turnEndDisposition: 'identified' })

    const line = { type: 'assistant.message', data: { content: 'Tests pass.' } }
    writeFileSync(transcriptPath, `${JSON.stringify(line)}\n`)
    await vi.waitFor(() => expect(row()?.lastAssistantMessage).toBe('Tests pass.'))
    expect(row()).toMatchObject({ turnEndedAt: ended, turnEndDisposition: 'identified' })
  })

  it('reaches the live push and survives a host restart, so a restatement stays the same end', async () => {
    const pushed: (number | undefined)[] = []
    server.setListener((status) => pushed.push(status.turnEndedAt))
    const stop = { hook_event_name: 'Stop', turn_id: 'turn-a', last_assistant_message: 'Done.' }
    await post(stop, '/hook/codex')
    const ended = row()?.turnEndedAt
    expect(pushed.at(-1)).toBe(ended)
    server.flushStatusPersistSync()
    server.stop()

    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath: directory })
    expect(row()).toMatchObject({ turnEndedAt: ended, turnEndDisposition: 'identified' })
    await post(
      { hook_event_name: 'PreToolUse', turn_id: 'turn-a', tool_name: 'Bash' },
      '/hook/codex'
    )
    await post(stop, '/hook/codex')
    expect(row()).toMatchObject({ state: 'done', turnEndedAt: ended })
  })

  it("keeps a relay's own end, never mints an older relay's, and restates none over an inferred cancel", () => {
    const grok = { paneKey: PANE, tabId: 'tab-1', source: 'grok' as const, hasExplicitPrompt: true }
    const working = {
      state: 'working' as const,
      prompt: 'Fix it',
      agentType: 'grok' as const,
      mainAgent: { state: 'working' as const, stateStartedAt: 1 }
    }
    const stop = { ...grok, hookEventName: 'stop', payload: { ...working, state: 'done' as const } }
    server.ingestRemote(stop, 'wsl-old')
    expect(row()).not.toHaveProperty('turnEndedAt')
    server.ingestRemote({ ...grok, hookEventName: 'user_prompt_submit', payload: working }, 'wsl')
    server.ingestRemote({ ...stop, turnEndedAt: 42, turnEndDisposition: 'ambiguous' }, 'wsl')
    expect(row()).toMatchObject({ turnEndedAt: 42, turnEndDisposition: 'ambiguous' })

    // The relay never learns a non-Claude cancel inferred here, so its late cancel hook carries an end.
    server.ingestRemote({ ...grok, hookEventName: 'user_prompt_submit', payload: working }, 'wsl')
    const turn = row()!
    expect(
      server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: turn.receivedAt,
        baselineStateStartedAt: turn.stateStartedAt,
        baselinePrompt: turn.prompt,
        baselineAgentType: 'grok',
        intent: 'ctrl-c'
      })
    ).toBe(true)
    const cancelled = row()
    const mainAgent = {
      state: 'done' as const,
      outcome: 'cancellation' as const,
      stateStartedAt: 2
    }
    server.ingestRemote(
      {
        ...grok,
        hookEventName: 'stop_cancelled',
        turnEndedAt: 50,
        turnEndDisposition: 'identified',
        payload: { ...working, state: 'done', mainAgent }
      },
      'wsl'
    )
    expect(row()).toMatchObject({ state: 'done', stateStartedAt: cancelled?.stateStartedAt })
    expect(row()).not.toHaveProperty('turnEndedAt')

    // A late plain Stop cannot replace the locally inferred cancellation end.
    const lateStop = {
      ...stop,
      turnEndedAt: 50,
      turnEndDisposition: 'identified' as const,
      payload: {
        ...working,
        state: 'done' as const,
        mainAgent: { state: 'done' as const, stateStartedAt: 3 }
      }
    }
    server.ingestRemote(lateStop, 'wsl')
    server.ingestRemote(
      { ...lateStop, payload: { ...lateStop.payload, lastAssistantMessage: 'Done.' } },
      'wsl'
    )
    server.ingestRemote({ ...lateStop, hookEventName: 'notification' }, 'wsl')
    expect(row()).toMatchObject({ state: 'done', stateStartedAt: cancelled?.stateStartedAt })
    expect(row()).not.toHaveProperty('turnEndedAt')

    // The next turn reaches main as working first, so its end is the relay's again.
    const next = { ...working, prompt: 'Again' }
    server.ingestRemote({ ...grok, hookEventName: 'user_prompt_submit', payload: next }, 'wsl')
    server.ingestRemote(
      {
        ...stop,
        turnEndedAt: 60,
        turnEndDisposition: 'identified',
        payload: { ...next, state: 'done' }
      },
      'wsl'
    )
    expect(row()).toMatchObject({ turnEndedAt: 60, turnEndDisposition: 'identified' })
  })
})
