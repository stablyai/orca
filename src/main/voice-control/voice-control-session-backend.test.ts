import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageType } from '../runtime/orchestration/types'
import {
  VoiceControlSessionBackendImpl,
  type VoiceControlSessionBackendDeps
} from './voice-control-session-backend'
import {
  PANE,
  harness,
  mailRow,
  lastToolOutput
} from './voice-control-session-backend-test-fixture'

describe('VoiceControlSessionBackendImpl', () => {
  it('list_agents answers with the roster and a gated response.create', async () => {
    const { deps, sent } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('list_agents', '{}', 'c1')
    expect(lastToolOutput(sent)).toContain('"oak"')
    // The state must reach the model even when the agent carries a task title (the
    // "still in progress" misanswer came from the title hiding the state).
    expect(lastToolOutput(sent)).toContain('working')
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  it('message_agent resolves the name, dispatches, and records the watchdog entry', async () => {
    const { deps, sent, terminalPrompts, toolActivity, agentActivity } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'message_agent',
      JSON.stringify({ name: 'oak', message: 'run the tests' }),
      'c1'
    )
    expect(terminalPrompts).toHaveLength(1)
    expect(terminalPrompts[0]?.body).toContain('run the tests')
    // Ownership framing: the coordinator stays on top of it — no "will report back".
    expect(lastToolOutput(sent)).toContain('Sent to oak')
    expect(lastToolOutput(sent)).toContain('stay on top of it')
    expect(lastToolOutput(sent)).not.toContain('report back')
    // The pill narrates tool + resolved agent; the output string stays provider-only.
    expect(toolActivity).toContainEqual({
      sessionId: 's1',
      tool: 'message_agent',
      target: 'oak'
    })
    expect(agentActivity).toContainEqual({
      sessionId: 's1',
      paneKey: PANE,
      activity: 'thinking',
      spokenName: 'oak'
    })
    // One-ack contract: a successful dispatch creates no follow-up response — the model
    // already acked, and the next spoken thing is oak's reply itself.
    expect(sent.some((e) => e.type === 'response.create')).toBe(false)
  })

  it('message_agent with an unknown name lists what exists instead of guessing', async () => {
    const { deps, sent, terminalPrompts, agentActivity } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'message_agent',
      JSON.stringify({ name: 'nobody', message: 'hi' }),
      'c1'
    )
    expect(terminalPrompts).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain('No agent or worktree matches "nobody"')
    expect(lastToolOutput(sent)).toContain('oak')
    // No chip for a name that never resolved to a pane.
    expect(agentActivity.some((a) => a.activity === 'thinking')).toBe(false)
  })

  it('malformed tool arguments produce a recoverable output, not a crash', async () => {
    const { deps, sent } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('message_agent', '{not json', 'c1')
    expect(lastToolOutput(sent)).toContain('missing a name or message')
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  // Live failure: a zombie open dispatch made createDispatchContext throw mid-ceremony;
  // the unhandled throw wedged the tool call and the model confabulated "I've already
  // sent the request". The failure must be SPOKEN, with the stuck-agent recovery hint.
  it('message_agent with a zombie dispatch answers honestly and names the recovery', async () => {
    const { deps, sent, terminalPrompts } = harness({
      dispatchError: 'Terminal term_abc already has an active dispatch (ctx_old for task_old)'
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'message_agent',
      JSON.stringify({ name: 'oak', message: 'report the exact output' }),
      'c1'
    )
    expect(terminalPrompts).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain('Could not dispatch to oak')
    expect(lastToolOutput(sent)).toContain('already has an active dispatch')
    // The output names the real recovery (fence the stale ctx, retry), not a dead end.
    expect(lastToolOutput(sent)).toContain('worker-abandon')
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  // The backstop: ANY throw out of a tool dispatch still produces a function_call_output
  // — without it the model's turn hangs on an unanswered call and it fills the silence.
  it('a tool dispatch that throws still answers the model instead of hanging the turn', async () => {
    const { deps, sent } = harness({ rosterError: 'hook server unreachable' })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'message_agent',
      JSON.stringify({ name: 'oak', message: 'hi' }),
      'c1'
    )
    expect(lastToolOutput(sent)).toContain('message_agent failed: hook server unreachable')
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  // Live failure: main 2's roster row was a stale 'done' over a bare shell — the
  // ceremony typed the preamble into the void and left a zombie dispatch context.
  // The liveness preflight (the CLI inject path's own probe) answers honestly instead.
  it('message_agent to a pane whose agent is gone refuses before writing anything', async () => {
    const { deps, sent, terminalPrompts } = harness({ agentRunning: false })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'message_agent',
      JSON.stringify({ name: 'oak', message: 'run the tests' }),
      'c1'
    )
    expect(terminalPrompts).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain('no agent running')
    expect(lastToolOutput(sent)).toContain('start_agent')
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  it('broadcast dispatches to every roster agent and stays silent on a clean send', async () => {
    const { deps, sent, terminalPrompts } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('broadcast', JSON.stringify({ message: 'status?' }), 'c1')
    expect(terminalPrompts).toHaveLength(1)
    expect(sent.some((e) => e.type === 'response.create')).toBe(false)
  })

  it('navigate_ui focus-agent sends the activate + focus messages for the resolved pane', async () => {
    const { deps, focused } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'navigate_ui',
      JSON.stringify({ verb: 'focus-agent', agent: 'oak' }),
      'c1'
    )
    expect(focused).toHaveLength(1)
    expect(focused[0]?.map((m) => m.channel)).toEqual(['ui:activateWorktree', 'ui:focusTerminal'])
  })

  it('navigate_ui surface verbs send the ui channel the renderer already obeys', async () => {
    const { deps, focused, sent } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('navigate_ui', JSON.stringify({ verb: 'tasks' }), 'c1')
    expect(focused).toEqual([[{ channel: 'ui:openTasks', payload: {} }]])
    expect(lastToolOutput(sent)).toContain('opened the task list')
    // Navigation confirms out loud — the user asked to be shown something.
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  it('navigate_ui with an unknown verb asks instead of guessing', async () => {
    const { deps, focused, sent } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('navigate_ui', JSON.stringify({ verb: 'explode' }), 'c1')
    expect(focused).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain('missing a known verb')
  })

  // Live failure, 20:25 session: "go back to the app" fired workspace-board twice while
  // the user sat in settings — leaving settings needs its own channel, not another open.
  it('navigate_ui close-settings fires the ui:closeSettings channel', async () => {
    const { deps, focused, sent } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('navigate_ui', JSON.stringify({ verb: 'close-settings' }), 'c1')
    expect(focused).toEqual([[{ channel: 'ui:closeSettings', payload: {} }]])
    expect(lastToolOutput(sent)).toContain('closed settings')
  })

  // Live failure, the 4869 session: "open up the issue" had no tool — the model opened a
  // BLANK browser tab (new-browser-tab), guessed a nonexistent `orca browser open`, fought
  // the address bar, and finally clicked "Open in default browser", leaving the user
  // staring at about:blank in the embedded tab. open_url is the missing capability.
  it('open_url opens the page foregrounded and says so', async () => {
    const { deps, sent, openedUrls, toolActivity } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'open_url',
      JSON.stringify({ url: 'https://github.com/workato/otto/issues/4869' }),
      'c1'
    )
    expect(openedUrls).toEqual(['https://github.com/workato/otto/issues/4869'])
    expect(lastToolOutput(sent)).toContain('opened https://github.com/workato/otto/issues/4869')
    // The pill narrates with the host, and the user hears the confirmation.
    expect(toolActivity).toContainEqual({ sessionId: 's1', tool: 'open_url', target: 'github.com' })
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  it('open_url refuses non-web URLs before any tab exists', async () => {
    const { deps, sent, openedUrls } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('open_url', JSON.stringify({ url: 'file:///etc/passwd' }), 'c1')
    expect(openedUrls).toEqual([])
    expect(lastToolOutput(sent)).toContain('http/https')
  })

  it('open_url with a transcribed non-URL asks for the address instead of opening junk', async () => {
    const { deps, sent, openedUrls } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('open_url', JSON.stringify({ url: 'the issue page' }), 'c1')
    expect(openedUrls).toEqual([])
    expect(lastToolOutput(sent)).toContain('not a readable URL')
  })

  it('open_url relays the tab-create refusal (remote runtime active) instead of claiming success', async () => {
    const { deps, sent } = harness({
      openUrlError: 'Browser tabs are unavailable while a remote runtime is active'
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('open_url', JSON.stringify({ url: 'https://example.com' }), 'c1')
    expect(lastToolOutput(sent)).toContain('Could not open that page')
    expect(lastToolOutput(sent)).toContain('remote runtime')
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  it('describe_screen answers with the on-screen state and names the workspace', async () => {
    const { deps, sent, toolActivity } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('describe_screen', '{}', 'c1')
    expect(lastToolOutput(sent)).toContain('oak')
    expect(lastToolOutput(sent)).toContain('README.md')
    expect(toolActivity).toContainEqual({
      sessionId: 's1',
      tool: 'describe_screen',
      target: 'oak'
    })
    // An answer the model must relay — never silent.
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  it('describe_screen with no owner window says so honestly instead of hanging', async () => {
    const { deps, sent } = harness({ screen: null })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('describe_screen', '{}', 'c1')
    expect(lastToolOutput(sent)).toContain('not available')
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  it('see_screen hands the model the UI tree and answers out loud', async () => {
    const { deps, sent } = harness({
      screenTree: '[@e1] button "Assigned to me"\n  text "#4882 Asana plugin…"'
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('see_screen', '{}', 'c1')
    expect(lastToolOutput(sent)).toContain('[@e1] button "Assigned to me"')
    expect(lastToolOutput(sent)).toContain('#4882')
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  it('see_screen with no debugger says so honestly', async () => {
    const { deps, sent } = harness({ screenTree: null })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('see_screen', '{}', 'c1')
    expect(lastToolOutput(sent)).toContain('not available')
  })

  it('click_element acts on the ref and answers with the fresh screen', async () => {
    const { deps, sent, uiActions, toolActivity } = harness({
      uiActionResult: {
        ok: true,
        elementName: 'Assigned to me',
        tree: '[@e1] button "Assigned to me" [pressed]'
      }
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('click_element', JSON.stringify({ ref: '@e1' }), 'c1')
    expect(uiActions).toEqual([{ kind: 'click', ref: '@e1' }])
    expect(lastToolOutput(sent)).toContain('clicked "Assigned to me"')
    expect(lastToolOutput(sent)).toContain('[pressed]')
    // The pill names what was clicked.
    expect(toolActivity).toContainEqual({
      sessionId: 's1',
      tool: 'click_element',
      target: 'Assigned to me'
    })
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  // Forensics: the 21:45 session's clicks were invisible in the durable log — every
  // screen action now records a 'ui' line the panel and the after-restart log both show.
  it('click_element records a ui line in the transcript', async () => {
    const { deps, transcript } = harness({
      uiActionResult: { ok: true, elementName: 'Assigned to me', tree: '[@e1] button "…"' }
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('click_element', JSON.stringify({ ref: '@e1' }), 'c1')
    expect(transcript).toContainEqual(
      expect.objectContaining({ kind: 'ui', summary: 'Clicked "Assigned to me".' })
    )
  })

  it("click_element relays the driver's refusal instead of claiming success", async () => {
    const { deps, sent } = harness({
      uiActionResult: { ok: false, error: 'Unknown ref "@e9" — call see_screen first.' }
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('click_element', JSON.stringify({ ref: '@e9' }), 'c1')
    expect(lastToolOutput(sent)).toContain('did not work')
    expect(lastToolOutput(sent)).toContain('see_screen')
  })

  it('type_into sends the ref and text through', async () => {
    const { deps, sent, uiActions } = harness({
      uiActionResult: { ok: true, elementName: 'Search', tree: '[@e4] textbox "Search"' }
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'type_into',
      JSON.stringify({ ref: '@e4', text: 'is:issue assignee:@me' }),
      'c1'
    )
    expect(uiActions).toEqual([{ kind: 'type', ref: '@e4', text: 'is:issue assignee:@me' }])
    expect(lastToolOutput(sent)).toContain('typed into "Search"')
  })

  // Live failure: "can you see the terminal?" got "I can't see the terminal view" while
  // the pane sat on screen — the tree excludes xterm, so the answer needs its own tool.
  it('read_terminal answers with the visible pane text', async () => {
    const { deps, sent } = harness({ terminalText: '$ npm test\n  42 passing\n' })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('read_terminal', '{}', 'c1')
    expect(lastToolOutput(sent)).toContain('42 passing')
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
  })

  it('read_terminal says when no terminal is visible rather than inventing one', async () => {
    const { deps, sent } = harness({ terminalText: '   \n' })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('read_terminal', '{}', 'c1')
    expect(lastToolOutput(sent)).toContain('No terminal pane is visible')
  })

  it('run_command runs in the default cwd, answers with the output, and logs the command', async () => {
    const { deps, sent, commands, transcript } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'run_command',
      JSON.stringify({ command: 'git status --short' }),
      'c1'
    )
    expect(commands).toEqual([{ command: 'git status --short', cwd: '/floating' }])
    expect(lastToolOutput(sent)).toContain('git status --short')
    expect(lastToolOutput(sent)).toContain('all good')
    // Command output IS the answer — the model must get a response turn.
    expect(sent.some((e) => e.type === 'response.create')).toBe(true)
    expect(transcript).toContainEqual(
      expect.objectContaining({ kind: 'command', command: 'git status --short', cwd: '/floating' })
    )
  })

  it('run_command with an agent name runs in that agent’s worktree', async () => {
    const { deps, commands } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'run_command',
      JSON.stringify({ command: 'ls', agent: 'oak' }),
      'c1'
    )
    expect(commands).toEqual([{ command: 'ls', cwd: '/tmp/x' }])
  })

  it('run_command with an unknown agent runs nothing and says so', async () => {
    const { deps, sent, commands } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'run_command',
      JSON.stringify({ command: 'ls', agent: 'nobody' }),
      'c1'
    )
    expect(commands).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain('No running agent matches "nobody"')
  })

  it('run_command refuses a remote-host worktree instead of running locally', async () => {
    // SSH execution boundary: the worktree path lives on another host; a local spawn
    // would answer for the wrong repository.
    const { deps, sent, commands } = harness({ remoteWorktree: true })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'run_command',
      JSON.stringify({ command: 'git status', agent: 'oak' }),
      'c1'
    )
    expect(commands).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain('remote host')
    expect(lastToolOutput(sent)).toContain('message_agent')
  })

  it('run_command refuses outright while a remote runtime drives the window', async () => {
    const { deps, sent, commands } = harness({ remoteRuntime: true })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall('run_command', JSON.stringify({ command: 'ls' }), 'c1')
    expect(commands).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain('remote runtime')
    expect(lastToolOutput(sent)).toContain('message_agent')
  })

  it('relays agent mail as a system note with the relay instructions override', async () => {
    const { deps, sent, agentActivity, transcript } = harness({
      mail: [mailRow({ sender_pane_key: PANE, body: 'login fix shipped' })]
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The provider locks the session voice after the first reply — no voice dance.
    expect(sent.some((e) => e.type === 'session.update')).toBe(false)
    const item = sent.find((e) => e.type === 'conversation.item.create')
    expect(item).toMatchObject({ item: { type: 'message', role: 'system' } })
    expect(JSON.stringify(item)).toContain(
      'System note — an update from oak, whose work you kicked off: login fix shipped'
    )
    // The compliance fix for the "Okay." failure: per-response instructions, not an
    // in-band "read this" prefix. Fixture mode is per-agent → the reporter is named.
    const create = sent.find((e) => e.type === 'response.create')
    expect(JSON.stringify(create)).toContain('leading with the name of the agent')
    expect(agentActivity).toContainEqual({
      sessionId: 's1',
      paneKey: PANE,
      activity: 'speaking',
      spokenName: 'oak'
    })
    expect(transcript).toContainEqual(
      expect.objectContaining({ kind: 'update', spokenName: 'oak', text: 'login fix shipped' })
    )
  })

  it('clears the pane chip with an idle event once the spoken reply settles', async () => {
    const { deps, sent, agentActivity } = harness({
      mail: [mailRow({ sender_pane_key: PANE, body: 'login fix shipped' })]
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The reply's response.create carries the gate's correlation ref; the chip clears
    // only when THAT response reports done.
    const ref = String(sent.find((e) => e.type === 'response.create')?.event_id)
    backend.observeEvent({
      type: 'response.created',
      response: { id: 'resp_reply', metadata: { ref } }
    })
    backend.observeEvent({ type: 'response.done', response: { id: 'resp_reply' } })
    expect(agentActivity).toContainEqual({
      sessionId: 's1',
      paneKey: PANE,
      activity: 'idle'
    })
  })

  it('relays pane-less session mail with no agent name', async () => {
    const { deps, sent } = harness({
      mail: [
        mailRow({ type: 'status', from_handle: 'orca_session_id:sess-9', body: 'all healthy' })
      ]
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Single-agent persona: unattributed — no name prefix, first-person relay even in
    // the fixture's per-agent mode.
    const item = sent.find((e) => e.type === 'conversation.item.create')
    expect(JSON.stringify(item)).toContain(
      'System note — an update on work you kicked off: all healthy'
    )
    const create = sent.find((e) => e.type === 'response.create')
    expect(JSON.stringify(create)).toContain('in first person')
  })
})

describe('watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // The dispatch itself creates one function-output item; the watchdog's items are the
  // ones after this baseline.
  async function dispatchWork(
    deps: VoiceControlSessionBackendDeps,
    sent: Record<string, unknown>[]
  ) {
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'message_agent',
      JSON.stringify({ name: 'oak', message: 'run the tests' }),
      'c1'
    )
    const baseline = sent.length
    return {
      backend,
      watchdogItems: () => sent.slice(baseline).filter((e) => e.type === 'conversation.item.create')
    }
  }

  it('announces a done agent once, then never again', async () => {
    const { deps, sent, transcript } = harness({ agentState: 'done' })
    const { backend, watchdogItems } = await dispatchWork(deps, sent)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(watchdogItems()).toHaveLength(1)
    expect(JSON.stringify(watchdogItems()[0])).toContain('oak reports done')
    expect(transcript).toContainEqual(
      expect.objectContaining({ kind: 'update', spokenName: 'oak' })
    )
    await vi.advanceTimersByTimeAsync(60_000)
    // Settled on first announcement: the ledger entry is gone, no second turn.
    expect(watchdogItems()).toHaveLength(1)
    backend.dispose()
  })

  it('flags a waiting agent as needing the user', async () => {
    const { deps, sent } = harness({ agentState: 'waiting' })
    const { backend, watchdogItems } = await dispatchWork(deps, sent)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(watchdogItems()).toHaveLength(1)
    expect(JSON.stringify(watchdogItems()[0])).toContain("needs the user's input")
    await vi.advanceTimersByTimeAsync(60_000)
    // Deduped by pane+kind — the same waiting state is not re-announced.
    expect(watchdogItems()).toHaveLength(1)
    backend.dispose()
  })

  it('says nothing while the agent is still working', async () => {
    const { deps, sent } = harness({ agentState: 'working' })
    const { backend, watchdogItems } = await dispatchWork(deps, sent)
    await vi.advanceTimersByTimeAsync(120_000)
    // No finding → no model turn → zero audio cost.
    expect(watchdogItems()).toHaveLength(0)
    backend.dispose()
  })

  it('stops firing once the session is disposed', async () => {
    const { deps, sent } = harness({ agentState: 'done' })
    const { backend, watchdogItems } = await dispatchWork(deps, sent)
    backend.dispose()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(watchdogItems()).toHaveLength(0)
  })
})

describe('wake types', () => {
  it('never subscribes to heartbeats', async () => {
    const { CONTROL_WAKE_TYPES } = await import('./voice-control-reply-pump')
    expect(CONTROL_WAKE_TYPES).not.toContain('heartbeat')
    const types: MessageType[] = CONTROL_WAKE_TYPES
    expect(types.length).toBeGreaterThan(0)
  })
})
