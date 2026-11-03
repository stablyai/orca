import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PANE } from './server.test-fixtures'

import '../../shared/hook-process-root-evidence'

import '../../wsl-guest/agent-hook-server'
import '../../wsl-guest/relay-pane-root'
import './local-tmux-managed-pty'

import {
  NOW,
  CLAUDE,
  NESTED,
  SHIM,
  TMUX,
  TMUX_HINT,
  io,
  live,
  probe,
  paths,
  attempts,
  codexTurn,
  capture,
  createServer,
  runningPane,
  hook,
  observe,
  slowRoot,
  settled,
  type RootTestServer,
  registerRootTestHarness,
  type Proc
} from './server-hook-root.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: vi.fn() }))

registerRootTestHarness()

// Orca's own agent-teams launch sets this synthetic TMUX; its Claudes run in no tmux server.
const AGENT_TEAMS_HINT = '%1 /tmp/orca-claude-agent-teams/team-x'
const unboundRoot = () => {
  runningPane(49969, CLAUDE)
  io.resolveRoot.mockResolvedValueOnce(null)
}

describe('an empty pane whose first hook cannot be proved', () => {
  it.each<[string, () => void, string?]>([
    ['a spawning shim', () => runningPane(49960, ...SHIM)],
    [
      'an ancestor whose argv is unreadable',
      () =>
        runningPane(
          49960,
          [49960, 101, 49960, '(node)', 'S+'],
          [49969, 49960, 49960, 'claude', 'S+']
        )
    ],
    ['a pane whose root its PTY owner has not named yet', unboundRoot],
    ['an agent-teams Claude whose root is not named yet', unboundRoot, AGENT_TEAMS_HINT]
  ])(
    'records %s as main does, as a fallback its own exit retires once',
    async (_name, setup, tmuxPane) => {
      const server = await createServer()
      setup()
      // A trust prompt is an observation, never ownership: the pane is still empty.
      observe(server, 'waiting')
      await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Task', tmuxPane })
      expect(server.row()).toMatchObject({ state: 'working', prompt: 'Task' })
      expect(server.presence()).toMatchObject({
        process: capture(49969),
        session: 'session-a',
        fallback: true
      })
      expect(server.hasVerifiableAgentProcess(PANE)).toBe(true)
      // Its own hooks and terminal reports never turn it into proof.
      await hook(server, 'PostToolUse', { session: 'session-a' })
      observe(server, 'working')
      expect(server.presence()?.fallback).toBe(true)
      // It keeps main's protection from another provider's process-less hooks.
      await codexTurn(server, 'Codex task')
      expect(server.row()?.agentType).toBe('claude')
      expect(server.presence()).toMatchObject({ agent: 'claude', process: capture(49969) })
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      expect(server.exits).toBe(1)
    }
  )

  it('records a first hook whose evidence misses its answer deadline, then upgrades it', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    const release = slowRoot()
    const started = performance.now()
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Task' })
    expect(performance.now() - started).toBeLessThan(700)
    expect(server.presence()).toMatchObject({ process: capture(49969), fallback: true })
    release()
    await settled()
    expect(server.presence()?.fallback).toBeUndefined()
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
    expect(server.row()).toMatchObject({ state: 'working', prompt: 'Task' })
  })

  it.each([['running'], ['restored']])(
    'lets the pane’s proved root replace a %s fallback that is still live',
    async (mode) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-root-fallback-'))
      paths.push(userDataPath)
      let server = await createServer(userDataPath)
      // A nested run reports first while the pane's binding is not hydrated yet.
      runningPane(
        49970,
        [49970, 101, 49970, 'claude', 'S+'],
        [49975, 49970, 49975, 'zsh -c claude -p x', 'Ss', '??'],
        [49969, 49975, 49975, 'claude -p x', 'S', '??']
      )
      io.resolveRoot.mockResolvedValueOnce(null)
      await hook(server, 'UserPromptSubmit', { session: 'nested', prompt: 'Nested' })
      expect(server.presence()).toMatchObject({ process: capture(49969), fallback: true })
      if (mode === 'restored') {
        server.flushStatusPersistSync()
        server.stop()
        server = await createServer(userDataPath)
        expect(server.presence()).toMatchObject({ process: capture(49969), fallback: true })
      }
      await hook(server, 'PostToolUse', { session: 'session-a', pid: 49970 })
      expect(server.presence()).toMatchObject({ process: capture(49970), session: 'session-a' })
      expect(server.presence()?.fallback).toBeUndefined()
      // The child's later exit is refused before it can end the pane.
      await hook(server, 'SessionEnd', { session: 'nested', reason: 'prompt_input_exit' })
      expect(server.exits).toBe(0)
    }
  )
})

describe('a Claude in a tmux session the pane does not show', () => {
  it.each([
    ['with', TMUX_HINT],
    ['without', undefined]
  ])(
    'shows its status, session and Done without recording a process, %s the hook’s hint',
    async (_name, tmuxPane) => {
      const server = await createServer()
      runningPane(101, ...TMUX)
      const sender = { session: 'tmux', pid: 4043, tmuxPane }
      await hook(server, 'UserPromptSubmit', { ...sender, prompt: 'In tmux' })
      expect(server.row()).toMatchObject({ state: 'working', prompt: 'In tmux' })
      await hook(server, 'Stop', sender)
      expect(server.row()).toMatchObject({ state: 'done', providerSession: { id: 'tmux' } })
      expect(server.presence()).toEqual({ agent: 'claude', session: 'tmux' })
      await hook(server, 'SessionEnd', { ...sender, reason: 'prompt_input_exit' })
      expect(server.exits).toBe(0)
    }
  )

  it('withdraws a fallback recorded before an unhinted read found the session', async () => {
    const server = await createServer()
    runningPane(101, ...TMUX)
    const release = slowRoot()
    await hook(server, 'UserPromptSubmit', { session: 'tmux', pid: 4043, prompt: 'In tmux' })
    expect(server.presence()).toMatchObject({ process: capture(4043), fallback: true })
    release()
    await settled()
    expect(server.presence()).toEqual({ agent: 'claude', session: 'tmux' })
    expect(server.row()).toMatchObject({ state: 'working', prompt: 'In tmux' })
    expect(server.exits).toBe(0)
  })
})

// The late answer lands on an unproven record, or on the status-only record a hinted first hook
// minted into an empty pane while the read was pending.
const lateStarts: [string, (server: RootTestServer) => Promise<void>, string?][] = [
  [
    'an unproven record',
    (server) => hook(server, 'UserPromptSubmit', { session: 'older', pid: null, prompt: 'Old' })
  ],
  ['an empty pane’s status-only first hook', async () => {}, TMUX_HINT]
]

describe('a late answer on a slow host', () => {
  it.each(lateStarts)(
    'heals %s as the root lands, with no later hook or replayed prompt',
    async (_name, start, tmuxPane) => {
      const server = await createServer()
      runningPane(49969, CLAUDE)
      await start(server)
      const release = slowRoot()
      await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'New task', tmuxPane })
      expect(server.presence()?.process).toBeUndefined()
      release()
      await settled()
      expect(server.presence()?.process).toEqual(capture(49969))
      expect(server.row()).toMatchObject({ state: 'working', prompt: 'New task' })
      vi.clearAllMocks()
      vi.setSystemTime(NOW + 15_000)
      await hook(server, 'PostToolUse', { session: 'session-a' })
      await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Next' })
      expect(attempts()).toBe(0)
    }
  )

  it.each(lateStarts)(
    'retires %s on a late exit proof once, with no later hook',
    async (_name, start, tmuxPane) => {
      const server = await createServer()
      runningPane(49969, CLAUDE)
      await start(server)
      const release = slowRoot()
      if (tmuxPane) {
        await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Task', tmuxPane })
      }
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      expect(server.exits).toBe(0)
      // A compatible status update while the answer is pending keeps the exit owed.
      observe(server, 'working')
      release()
      await settled()
      expect(server.exits).toBe(1)
      expect(server.presence()).toMatchObject({ process: capture(49969), ended: true })
    }
  )

  it.each<[string, (server: RootTestServer) => Promise<void> | void]>([
    ['the pane closed', (server) => server.clearPaneState(PANE, { forgetAgentExit: true })],
    // The exiting process left the pane's job before its membership could be read.
    ['the job changed', () => runningPane(101)]
  ])('owes no exit once %s while the answer was pending', async (_name, change) => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    await hook(server, 'UserPromptSubmit', { session: 'older', pid: null, prompt: 'Old task' })
    const release = slowRoot()
    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    await change(server)
    release()
    await settled()
    expect(server.exits).toBe(0)
  })

  it('owes no exit to a record another process minted after the exit was seen', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    const release = slowRoot()
    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    await hook(server, 'UserPromptSubmit', { session: 'other', pid: null, prompt: 'Other' })
    release()
    await settled()
    expect(server.exits).toBe(0)
    expect(server.presence()).toEqual({ agent: 'claude', session: 'other' })
  })
})

describe('a suspended owner', () => {
  function suspend(): void {
    probe.mockImplementation(async (identity, _read, _platform, onSuspension) => {
      if (identity?.pid === 49969) {
        onSuspension?.(true)
        return 'unverifiable'
      }
      return identity && live.has(identity.pid) ? 'live' : 'unverifiable'
    })
  }

  it.each<[string, Proc[], number]>([
    ['a nested run', NESTED, 49980],
    [
      'an editor terminal’s process',
      [
        [60000, 1, 60000, '/Applications/Code.app/Contents/MacOS/Code Helper', 'S', '??'],
        [60001, 60000, 60001, 'claude', 'S+', 'ttys009']
      ],
      60001
    ],
    [
      'a process whose lineage is unreadable',
      [
        [49990, 101, 49990, '(node)', 'S'],
        [49991, 49990, 49990, 'claude', 'S']
      ],
      49991
    ]
  ])('keeps %s from replacing it, before any provider fold', async (_name, procs, pid) => {
    const server = await createServer()
    runningPane(49969, CLAUDE, ...procs)
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Parent task' })
    suspend()
    await server.checkAgentPresence(PANE)
    expect(server.presence()?.suspended).toBe(true)
    const before = attempts()
    await hook(server, 'UserPromptSubmit', { session: 'child', pid, prompt: 'Child task' })
    await hook(server, 'SessionEnd', { session: 'child', pid, reason: 'prompt_input_exit' })
    expect(attempts()).toBeGreaterThan(before)
    expect(server.presence()).toMatchObject({
      process: capture(49969),
      session: 'session-a',
      suspended: true
    })
    expect(server.row()).toMatchObject({ prompt: 'Parent task' })
    expect(server.foldedPrompt()).toBe('Parent task')
    expect(server.exits).toBe(0)
  })

  it('yields to the pane’s new foreground agent, whose record the stopped one cannot end', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    await hook(server, 'SessionStart', { session: 'session-a' })
    suspend()
    await server.checkAgentPresence(PANE)
    runningPane(49970, [49969, 101, 49969, 'claude', 'T'], [49970, 101, 49970, 'claude', 'S+'])
    await hook(server, 'SessionStart', { session: 'session-b', pid: 49970 })
    expect(server.presence()).toMatchObject({ process: capture(49970), session: 'session-b' })
    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    expect(server.presence()).toMatchObject({ process: capture(49970) })
    expect(server.exits).toBe(0)
  })

  it('lets its own unproven fallback resume after fg, still a fallback a proved root replaces', async () => {
    const server = await createServer()
    runningPane(49960, ...SHIM)
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Before' })
    await hook(server, 'Stop', { session: 'session-a' })
    suspend()
    await server.checkAgentPresence(PANE)
    expect(server.presence()).toMatchObject({ fallback: true, suspended: true })
    // fg: the same process posts its next turn.
    probe.mockImplementation(async (identity) =>
      identity && live.has(identity.pid) ? 'live' : 'unverifiable'
    )
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'After fg' })
    expect(server.row()).toMatchObject({ state: 'working', prompt: 'After fg' })
    expect(server.presence()).toMatchObject({ process: capture(49969), fallback: true })
    expect(server.presence()?.suspended).toBeUndefined()
    runningPane(49969, CLAUDE)
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Proved' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
    expect(server.presence()?.fallback).toBeUndefined()
  })
})

describe('an owner’s exit seen by a challenging hook', () => {
  it('keeps the proved exit when the challenger is refused', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE, ...NESTED)
    await hook(server, 'SessionStart', { session: 'session-a' })
    probe.mockImplementation(async (identity) =>
      identity?.pid === 49969
        ? 'exited'
        : identity && live.has(identity.pid)
          ? 'live'
          : 'unverifiable'
    )
    await hook(server, 'UserPromptSubmit', { session: 'nested', pid: 49980, prompt: 'nested' })
    expect(await server.checkAgentPresenceSince(PANE, NOW - 1)).toBe('exited')
  })
})
