import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import {
  NOW,
  CLAUDE,
  NESTED,
  BACKGROUND,
  probe,
  paths,
  attempts,
  codexTurn,
  capture,
  createServer,
  runningPane,
  hook,
  observe,
  type RootTestServer,
  registerRootTestHarness
} from './server-hook-root.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn()
}))

registerRootTestHarness()

describe('a pane without a proven owner', () => {
  it.each<[string, (server: RootTestServer) => Promise<void> | void]>([
    ['no record yet', () => {}],
    ['a trust prompt seen before the first hook', (server) => observe(server, 'waiting')],
    [
      'a forked resume seeded with its source session',
      (server) => {
        server.recordLaunchResumeIdentity({
          paneKey: PANE,
          worktreeId: 'wt-1',
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'fork-source' },
          launchedAt: NOW - 1
        })
        observe(server, 'waiting')
      }
    ],
    [
      'an owner in another session whose hooks sent no process',
      (server) => hook(server, 'UserPromptSubmit', { session: 'older', pid: null, prompt: 'old' })
    ],
    [
      'an owner in the same session whose hooks sent no process',
      (server) =>
        hook(server, 'UserPromptSubmit', { session: 'session-a', pid: null, prompt: 'old' })
    ],
    ['another agent whose turn was left working when it exited', (server) => codexTurn(server)],
    [
      'another agent that left its record in the pane',
      async (server) => {
        await codexTurn(server)
        await hook(server, 'Stop', { session: 'cx', pid: null, source: 'codex' })
      }
    ]
  ])('acquires %s from its root agent on an ordinary hook', async (_name, setup) => {
    const server = await createServer()
    runningPane(49969, CLAUDE, ...NESTED)
    await setup(server)
    await hook(server, 'PostToolUse', { session: 'session-a' })
    expect(server.presence()).toMatchObject({
      agent: 'claude',
      process: capture(49969),
      session: 'session-a'
    })
    expect(server.row()).toMatchObject({
      agentType: 'claude',
      providerSession: { id: 'session-a' }
    })
    // Once acquired, the owner's exact process keeps a nested run out of its row.
    await hook(server, 'UserPromptSubmit', { session: 'nested', pid: 49980, prompt: 'nested task' })
    expect(server.row()?.providerSession?.id).toBe('session-a')
    expect(attempts()).toBe(1)
  })

  it('acquires a Claude started through a shell script named claude', async () => {
    const server = await createServer()
    runningPane(
      49960,
      [49960, 101, 49960, 'bash /Users/u/bin/claude', 'S+'],
      [49969, 49960, 49960, 'node /opt/homebrew/bin/claude', 'S+']
    )
    observe(server, 'waiting')
    await hook(server, 'SessionStart', { session: 'session-a' })
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Wrapped task' })
    expect(server.row()).toMatchObject({ state: 'working', prompt: 'Wrapped task' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
  })

  it.each([['parent'], [undefined]])(
    'keeps a detached nested run out of an unproven owner in session %s, through its exit',
    async (session) => {
      const server = await createServer()
      runningPane(49969, CLAUDE, ...NESTED)
      await hook(server, 'UserPromptSubmit', { session, pid: null, prompt: 'Parent task' })
      await hook(server, 'UserPromptSubmit', {
        session: 'nested',
        pid: 49980,
        prompt: 'nested task'
      })
      await hook(server, 'Stop', { session: 'nested', pid: 49980 })
      await hook(server, 'SessionEnd', {
        session: 'nested',
        pid: 49980,
        reason: 'prompt_input_exit'
      })
      expect(server.row()).toMatchObject({ state: 'working', prompt: 'Parent task' })
      expect(server.presence()?.process).toBeUndefined()
      expect(server.exits).toBe(0)
    }
  )

  it('keeps a nested run that reports first out of the pane, then admits its parent', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE, ...NESTED)
    await hook(server, 'UserPromptSubmit', { session: 'nested', pid: 49980, prompt: 'nested' })
    expect(server.row()).toBeUndefined()
    await hook(server, 'PostToolUse', { session: 'session-a' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
  })

  it('keeps a background agent from taking a pane whose agent waits at its trust prompt', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE, BACKGROUND)
    observe(server, 'waiting')
    await hook(server, 'SessionStart', { session: 'nightly', pid: 49990 })
    await hook(server, 'UserPromptSubmit', { session: 'nightly', pid: 49990, prompt: 'Nightly' })
    expect(server.row()?.state).toBe('waiting')
    expect(server.presence()).toBeUndefined()
    await hook(server, 'SessionStart', { session: 'session-a' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
  })

  it('keeps a Claude in another terminal that inherited the pane key out of a Codex pane', async () => {
    const server = await createServer()
    runningPane(
      49969,
      [49969, 101, 49969, 'codex', 'S+'],
      [60000, 1, 60000, '/Applications/Code.app/Contents/MacOS/Code Helper', 'S', '??'],
      [60001, 60000, 60001, 'claude', 'S+', 'ttys009']
    )
    await codexTurn(server, 'Codex task')
    await hook(server, 'UserPromptSubmit', { session: 'foreign', pid: 60001, prompt: 'Foreign' })
    await hook(server, 'Stop', { session: 'cx', pid: null, source: 'codex' })
    expect(server.row()).toMatchObject({ agentType: 'codex', state: 'done', prompt: 'Codex task' })
    expect(server.presence()).toEqual({ agent: 'codex', session: 'cx' })
  })

  it('applies an unreadable acquisition as a hook without a process, then retries next turn', async () => {
    const server = await createServer()
    await hook(server, 'UserPromptSubmit', { session: 'older', pid: null, prompt: 'old' })
    await hook(server, 'UserPromptSubmit', { session: 'older', prompt: 'next' })
    expect(server.row()).toMatchObject({ state: 'working', prompt: 'next' })
    expect(server.presence()).toEqual({ agent: 'claude', session: 'older' })
    runningPane(49969, CLAUDE)
    await hook(server, 'UserPromptSubmit', { session: 'older', prompt: 'again' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'older' })
  })

  it.each([['older'], [undefined]])(
    'acquires an owner saved with session %s after a restart, from durable spool replay',
    async (session) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-root-acquisition-'))
      paths.push(userDataPath)
      const first = await createServer(userDataPath)
      await hook(first, 'UserPromptSubmit', { session, pid: null, prompt: 'old' })
      first.flushStatusPersistSync()
      first.stop()
      const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
      mkdirSync(spoolDir, { recursive: true })
      const record = {
        paneKey: PANE,
        source: 'claude',
        receivedAt: NOW,
        agentProcess: JSON.stringify(capture(49969)),
        payload: { hook_event_name: 'PostToolUse', session_id: 'session-a', tool_name: 'Bash' }
      }
      writeFileSync(join(spoolDir, 'pane-spooled.jsonl'), `\n${JSON.stringify(record)}\n`)
      runningPane(49969, CLAUDE)
      const restarted = await createServer(userDataPath)
      expect(restarted.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
    }
  )
})

describe('a scoped provider’s session binding', () => {
  it('keeps a Claude run under Hermes out, then lets the pane’s next Claude own it', async () => {
    const server = await createServer()
    runningPane(
      49960,
      [49960, 101, 49960, 'hermes', 'S+'],
      [49975, 49960, 49975, '/bin/bash -c claude -p summarize', 'Ss', '??'],
      [49980, 49975, 49975, 'claude -p summarize', 'S', '??']
    )
    const hermes = { pid: null, source: 'hermes', session: 'hermes-root' }
    await hook(server, 'pre_llm_call', hermes)
    await hook(server, 'UserPromptSubmit', { session: 'nested', pid: 49980, prompt: 'nested' })
    expect(server.presence()).toEqual({ agent: 'hermes' })
    expect(server.row()?.agentType).toBe('hermes')
    // Hermes exits and the user starts Claude in the same pane.
    runningPane(49969, CLAUDE)
    await hook(server, 'SessionStart', { session: 'session-a' })
    expect(server.presence()).toMatchObject({ agent: 'claude', process: capture(49969) })
  })
})

describe('the pane root’s exit', () => {
  it('retires an unproven record of its own agent once, whatever session it names', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    await hook(server, 'UserPromptSubmit', { session: 'older', pid: null, prompt: 'old' })
    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    expect(server.exits).toBe(1)
    expect(server.presence()).toMatchObject({
      agent: 'claude',
      process: capture(49969),
      session: 'session-a',
      ended: true
    })
    // A replayed or late exit from the retired process changes nothing.
    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    await hook(server, 'Stop', { session: 'session-a' })
    expect(server.exits).toBe(1)
  })
})

describe('terminal reports and Orca restatements', () => {
  it('keeps a resumed Codex conversation over a Claude run inside it', async () => {
    const server = await createServer()
    runningPane(49969, [49969, 101, 49969, 'codex resume cx', 'S+'], ...NESTED)
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'cx' },
      launchedAt: NOW - 1
    })
    observe(server, 'working', 'codex')
    await codexTurn(server, 'Codex task')
    await hook(server, 'Stop', { session: 'cx', pid: null, source: 'codex' })
    await hook(server, 'UserPromptSubmit', {
      session: 'nested',
      pid: 49980,
      prompt: 'Background job'
    })
    await codexTurn(server, 'Next task')
    expect(server.row()).toMatchObject({ agentType: 'codex', prompt: 'Next task' })
    expect(server.presence()).toEqual({ agent: 'codex', session: 'cx' })
  })

  it('keeps a suspended owner through a terminal report', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    await hook(server, 'SessionStart', { session: 'session-a' })
    probe.mockImplementationOnce(async (_identity, _read, _platform, onSuspension) => {
      onSuspension?.(true)
      return 'unverifiable'
    })
    await server.checkAgentPresence(PANE)
    observe(server, 'working')
    expect(server.presence()).toEqual({
      agent: 'claude',
      process: capture(49969),
      session: 'session-a',
      sessionOwner: true,
      suspended: true
    })
  })
})

describe('a retired owner', () => {
  it.each<[string, 'waiting' | 'working', 'process' | undefined]>([
    ['terminal', 'waiting', undefined],
    ['process-lifetime', 'working', 'process']
  ])(
    'shows the next agent through a %s report and admits only a new root',
    async (_name, state, origin) => {
      const server = await createServer()
      runningPane(49969, CLAUDE)
      await hook(server, 'SessionStart', { session: 'session-a' })
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      observe(server, state, 'claude', origin)
      expect(server.row()?.state).toBe(state)
      // Late and replayed hooks from the exited process change nothing.
      await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'stale prompt' })
      // Refused before provider folds, which the successor would otherwise inherit.
      expect(server.foldedPrompt()).toBeUndefined()
      await hook(server, 'Stop', { session: 'session-a' })
      await hook(server, 'SessionStart', { session: 'session-a' })
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      expect(server.row()?.state).toBe(state)
      expect(server.hasVerifiableAgentProcess(PANE)).toBe(false)
      // The user resumes the same conversation in a new process.
      runningPane(49970, [49970, 101, 49970, 'claude', 'S+'])
      await hook(server, 'PostToolUse', { session: 'session-a', pid: 49970 })
      expect(server.presence()).toMatchObject({ process: capture(49970), session: 'session-a' })
    }
  )
})

describe('relayed panes', () => {
  const RELAY = 'wsl:Ubuntu'
  const envelope = {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    source: 'claude',
    hookEventName: 'UserPromptSubmit',
    providerSession: { provider: 'claude', id: 'parent' },
    agentPresence: { agent: 'claude', session: 'parent' },
    payload: { state: 'working', prompt: 'Parent task', agentType: 'claude' }
  }
  const child = { pid: 4006, platform: 'linux' as const, startTime: 'boot:4006' }
  const nested = { agent: 'claude', process: child, session: 'nested', sessionOwner: true }
  const issue = (server: AgentHookServer, pane = PANE, isCurrent = () => true) =>
    server.relayPaneRootIssuer(RELAY)(pane, 'inc-1', isCurrent)

  it('adopts the owner a relay stamped with this link’s binding, without probing it', async () => {
    const server = await createServer()
    server.ingestRemote(envelope, RELAY)
    const paneRoot = issue(server)
    // The acquiring forward is lost; the owner's next forward carries the same stamp and heals.
    server.ingestRemote(
      {
        ...envelope,
        hookEventName: 'PostToolUse',
        agentPresence: { agent: 'claude', process: child, session: 'parent', paneRoot }
      },
      RELAY
    )
    expect(server.presence()).toMatchObject({ process: child, session: 'parent' })
    expect(server.presence()).not.toHaveProperty('paneRoot')
    expect(probe).not.toHaveBeenCalled()
    expect(attempts()).toBe(0)
  })

  it.each<[string, (server: AgentHookServer) => string | undefined]>([
    ['no binding (a legacy or empty answer)', () => undefined],
    [
      'another pane’s binding',
      (server) => issue(server, makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222'))
    ],
    [
      'a binding from before the link restarted',
      (server) => {
        const answer = server.relayPaneRootIssuer(RELAY)
        const stale = answer(PANE, 'inc-1', () => true)
        server.beginRemoteRelaySession(RELAY)
        // An answer still in flight across the restart binds nothing either.
        expect(answer(PANE, 'inc-1', () => true)).toBeUndefined()
        return stale
      }
    ],
    ['a binding whose PTY the pane no longer runs', (server) => issue(server, PANE, () => false)]
  ])('keeps a relayed nested run with %s from owning or ending the pane', async (_name, stamp) => {
    const server = await createServer()
    server.ingestRemote(envelope, RELAY)
    const paneRoot = stamp(server)
    const presence = { ...nested, ...(paneRoot ? { paneRoot } : {}) }
    server.ingestRemote(
      {
        ...envelope,
        isReplay: true,
        providerSession: { provider: 'claude', id: 'nested' },
        agentPresence: presence,
        payload: { ...envelope.payload, prompt: 'Nested task' }
      },
      RELAY
    )
    server.ingestRemote(
      {
        ...envelope,
        hookEventName: 'SessionEnd',
        providerSession: { provider: 'claude', id: 'nested' },
        agentPresence: { ...presence, ended: true }
      },
      RELAY
    )
    expect(server.presence()).toEqual({ agent: 'claude', session: 'parent' })
    expect(server.row()).toMatchObject({ state: 'working' })
    expect(server.exits).toBe(0)
  })

  it('records a relayed fallback only into an empty pane, where a stamped root replaces it', async () => {
    const server = await createServer()
    const fallback = { ...nested, fallback: true }
    server.ingestRemote(envelope, RELAY)
    server.ingestRemote({ ...envelope, agentPresence: fallback }, RELAY)
    expect(server.presence()).toEqual({ agent: 'claude', session: 'parent' })
    server.clearPaneState(PANE, { forgetAgentExit: true })
    server.ingestRemote({ ...envelope, agentPresence: fallback }, RELAY)
    expect(server.presence()).toMatchObject({ process: child, fallback: true })
    const root = { pid: 4001, platform: 'linux' as const, startTime: 'boot:4001' }
    server.ingestRemote(
      {
        ...envelope,
        agentPresence: {
          agent: 'claude',
          process: root,
          session: 'parent',
          paneRoot: issue(server)
        }
      },
      RELAY
    )
    expect(server.presence()).toMatchObject({ process: root, session: 'parent' })
    expect(server.presence()?.fallback).toBeUndefined()
  })
})
