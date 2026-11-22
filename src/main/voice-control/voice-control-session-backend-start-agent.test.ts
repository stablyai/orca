import { describe, expect, it } from 'vitest'
import { VoiceControlSessionBackendImpl } from './voice-control-session-backend'
import { harness, lastToolOutput } from './voice-control-session-backend-test-fixture'

describe('start_agent', () => {
  // "Restart it" must be real: a pane whose agent exited is a bare shell wearing a stale
  // roster row — messaging it writes a zombie dispatch, so start_agent launches fresh.
  it('start_agent on a pane whose agent is gone launches a fresh agent instead of messaging', async () => {
    const { deps, terminalPrompts, launches } = harness({ agentRunning: false })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'start_agent',
      JSON.stringify({ name: 'oak', message: 'run the date command' }),
      'c1'
    )
    expect(terminalPrompts).toHaveLength(0)
    expect(launches).toHaveLength(1)
    expect(launches[0]?.worktreeId).toBe('w1')
    expect(launches[0]?.prompt).toContain('run the date command')
  })

  // Live failure this guards: "use that same worktree we made before" sent the
  // coordinator CLI-spelunking into `orchestration worker-start` (which can never work
  // without a sender terminal) instead of just starting the agent there.
  it('start_agent wakes an idle worktree with its previous agent and the task as the startup dispatch', async () => {
    const { deps, sent, launches, toolActivity } = harness({ idleWorktree: true })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'start_agent',
      JSON.stringify({
        name: 'ci type checking guard',
        message: 'pick up the CI type checking guard work'
      }),
      'c1'
    )
    expect(launches).toHaveLength(1)
    const launch = launches[0]!
    expect(launch.worktreeId).toBe('w-idle')
    // Resume = the agent that ran there before, not the configured default (claude).
    expect(launch.agent).toBe('codex')
    expect(launch.preAllocatedHandle).toMatch(/^term_/)
    // The dispatch preamble IS the startup prompt: the task plus the reply-routing
    // commands addressed with the pre-allocated handle.
    expect(launch.prompt).toContain('pick up the CI type checking guard work')
    expect(launch.prompt).toContain(`--from ${launch.preAllocatedHandle}`)
    expect(lastToolOutput(sent)).toContain('Started codex in ci type checking guard')
    // One-ack contract: a clean start is covered by the model's ack, no follow-up response.
    expect(sent.some((event) => event.type === 'response.create')).toBe(false)
    expect(toolActivity).toContainEqual({
      sessionId: 's1',
      tool: 'start_agent',
      target: 'ci type checking guard'
    })
  })

  // Live failure this guards: "can't you just pick them?" got "I can't safely pick them"
  // — but the app's own new-workspace flow auto-picks from installed agents, and now
  // start_agent does too (worktree history → configured default → curated install order).
  it('start_agent auto-picks an installed agent when the worktree has no history and no default is set', async () => {
    const { deps, sent, launches } = harness({
      idleWorktree: true,
      defaultLaunchAgent: 'blank',
      installedAgents: ['codex']
    })
    // Strip the history: no createdWithAgent on the idle worktree.
    const baseGetRoster = deps.getRoster
    deps.getRoster = async () =>
      (await baseGetRoster()).map((summary) =>
        summary.worktreeId === 'w-idle'
          ? (() => {
              const { createdWithAgent: _ignored, ...rest } = summary
              return rest
            })()
          : summary
      )
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'start_agent',
      JSON.stringify({ name: 'ci type checking guard', message: 'pick up the guard work' }),
      'c1'
    )
    expect(launches).toHaveLength(1)
    expect(launches[0]!.agent).toBe('codex')
    expect(lastToolOutput(sent)).toContain('Started codex in ci type checking guard')
  })

  it('start_agent honors an explicit agent the user names', async () => {
    const { deps, sent, launches } = harness({ idleWorktree: true })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'start_agent',
      JSON.stringify({
        name: 'ci type checking guard',
        message: 'run date in bash',
        agent: 'claude'
      }),
      'c1'
    )
    expect(launches).toHaveLength(1)
    // The explicit pick overrides the worktree's codex history.
    expect(launches[0]!.agent).toBe('claude')
    expect(lastToolOutput(sent)).toContain('Started claude')
  })

  it('start_agent refuses an agent that is not installed, naming what is', async () => {
    const { deps, sent, launches } = harness({ idleWorktree: true })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'start_agent',
      JSON.stringify({ name: 'ci type checking guard', message: 'run date', agent: 'gemini' }),
      'c1'
    )
    expect(launches).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain("gemini isn't installed")
    expect(lastToolOutput(sent)).toContain('claude, codex')
  })

  it('start_agent refuses an agent id it does not know', async () => {
    const { deps, sent, launches } = harness({ idleWorktree: true })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'start_agent',
      JSON.stringify({ name: 'ci type checking guard', message: 'run date', agent: 'eugene' }),
      'c1'
    )
    expect(launches).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain('not an agent CLI I know')
  })

  it('start_agent on a REMOTE worktree skips the client-local installed scan', async () => {
    // gemini is not in the client's installed list — locally that refuses, but the
    // launch happens on the remote host, whose installed set this scan can't see.
    const { deps, sent, launches } = harness({
      idleWorktree: true,
      remoteIdleWorktree: true
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'start_agent',
      JSON.stringify({ name: 'ci type checking guard', message: 'run date', agent: 'gemini' }),
      'c1'
    )
    expect(launches).toHaveLength(1)
    expect(launches[0]!.agent).toBe('gemini')
    expect(lastToolOutput(sent)).toContain('Started gemini')
  })

  it('start_agent on a remote worktree with no history and no default asks the user to name one', async () => {
    const { deps, sent, launches } = harness({
      idleWorktree: true,
      remoteIdleWorktree: true,
      idleWorktreeHistory: null,
      defaultLaunchAgent: null,
      installedAgents: []
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'start_agent',
      JSON.stringify({ name: 'ci type checking guard', message: 'run date' }),
      'c1'
    )
    expect(launches).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain('remote host')
    expect(lastToolOutput(sent)).toContain('which agent to start')
  })

  it('start_agent asks which agent only when nothing can be picked', async () => {
    const { deps, sent, launches } = harness({
      idleWorktree: true,
      defaultLaunchAgent: 'blank',
      installedAgents: []
    })
    const baseGetRoster = deps.getRoster
    deps.getRoster = async () =>
      (await baseGetRoster()).map((summary) =>
        summary.worktreeId === 'w-idle'
          ? (() => {
              const { createdWithAgent: _ignored, ...rest } = summary
              return rest
            })()
          : summary
      )
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'start_agent',
      JSON.stringify({ name: 'ci type checking guard', message: 'pick up the guard work' }),
      'c1'
    )
    expect(launches).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain('Ask the user which agent')
  })

  it('start_agent on an already-running agent just messages it', async () => {
    const { deps, terminalPrompts, launches } = harness()
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'start_agent',
      JSON.stringify({ name: 'oak', message: 'how is the login fix going?' }),
      'c1'
    )
    expect(launches).toHaveLength(0)
    expect(terminalPrompts).toHaveLength(1)
    expect(terminalPrompts[0]!.body).toContain('how is the login fix going?')
  })

  it('message_agent on an idle worktree redirects to start_agent instead of a dead end', async () => {
    const { deps, sent, terminalPrompts } = harness({ idleWorktree: true })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'message_agent',
      JSON.stringify({ name: 'ci type checking guard', message: 'status?' }),
      'c1'
    )
    expect(terminalPrompts).toHaveLength(0)
    expect(lastToolOutput(sent)).toContain('idle worktree')
    expect(lastToolOutput(sent)).toContain('start_agent')
  })

  it('start_agent relays a launch failure instead of claiming success', async () => {
    const { deps, sent } = harness({
      idleWorktree: true,
      launchError: 'Selected agent is disabled.'
    })
    const backend = new VoiceControlSessionBackendImpl(deps)
    backend.start()
    await backend.dispatchToolCall(
      'start_agent',
      JSON.stringify({ name: 'ci type checking guard', message: 'pick up the guard work' }),
      'c1'
    )
    expect(lastToolOutput(sent)).toContain('failed: Selected agent is disabled.')
  })
})
