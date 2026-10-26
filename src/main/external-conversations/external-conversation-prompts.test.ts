import { describe, expect, it, vi } from 'vitest'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AgentPhase, AgentTransition } from '../../shared/agent-transitions'
import type { ConversationEvent, ConversationSnapshot } from './external-conversation-events'
import type { ConversationKey } from './external-conversation-types'
import {
  fakeLauncher,
  fakeTerminal,
  launchResult,
  PANE,
  WORKTREE
} from './external-conversation.test-fixture'
import { harness } from './external-conversation-seam.test-fixture'

const KEY: ConversationKey = { source: 'dev', externalId: 'thread-1' }
const START = {
  agent: 'claude',
  target: { kind: 'existing' as const, worktree: `id:${WORKTREE}` },
  prompt: 'first'
}

function hookRow(overrides: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    state: 'working',
    prompt: '',
    agentType: 'claude',
    paneKey: PANE,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 100,
    ...overrides
  }
}

const APPROVAL = hookRow({
  state: 'waiting',
  stateStartedAt: 200,
  interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'ls' } })
})

function moved(
  from: AgentPhase,
  to: AgentPhase,
  transition: AgentTransition | null
): AgentPaneChange {
  return {
    kind: 'moved',
    paneKey: PANE,
    workspace: { worktreeId: WORKTREE, sshHostId: null },
    from,
    to,
    at: 1,
    transition
  }
}

async function linked(settings = {}) {
  const h = harness(settings)
  const fake = fakeTerminal()
  const host = {
    launcher: fakeLauncher(async () => launchResult('handed-to-terminal')).launcher,
    terminal: fake.terminal
  }
  await h.seam.start(host, KEY, 'd1', START)
  return { ...h, fake, host }
}

describe('ExternalConversationSeam prompts', () => {
  it('reads the linked agent’s approval and answers it once, by its exact id', async () => {
    const { seam, host, hookRows, fake } = await linked()
    expect(seam.pendingPrompt(host, KEY)).toBeNull()
    hookRows.set(PANE, APPROVAL)
    const prompt = seam.pendingPrompt(host, KEY)
    expect(prompt).toMatchObject({ kind: 'approval', tool: 'Bash', summary: 'ls' })
    await expect(seam.answer(host, KEY, prompt!.promptId, 'allow_once')).resolves.toEqual({
      outcome: 'accepted'
    })
    expect(fake.keys).toEqual(['1'])
    await expect(seam.answer(host, KEY, prompt!.promptId, 'allow_once')).resolves.toEqual({
      outcome: 'refused',
      reason: 'prompt_not_pending'
    })
    expect(fake.keys).toEqual(['1'])
  })

  it('refuses an answer for a stale prompt, a replaced process, or a shell in front', async () => {
    const { seam, host, hookRows, fake } = await linked()
    hookRows.set(PANE, APPROVAL)
    const { promptId } = seam.pendingPrompt(host, KEY)!
    fake.replace()
    await expect(seam.answer(host, KEY, promptId, 'allow_once')).resolves.toMatchObject({
      reason: 'prompt_not_pending'
    })
    const fresh = seam.pendingPrompt(host, KEY)!.promptId
    fake.terminal.readLaunchedAgentForeground.mockResolvedValueOnce('shell')
    await expect(seam.answer(host, KEY, fresh, 'reject_once')).resolves.toMatchObject({
      reason: 'agent_not_reachable'
    })
    expect(fake.keys).toEqual([])
  })

  it('reads a prompt as unsupported once the agent’s hooks are off', async () => {
    const settings: { agentStatusHooksEnabled?: boolean } = {}
    const { seam, host, hookRows } = await linked(settings)
    hookRows.set(PANE, APPROVAL)
    settings.agentStatusHooksEnabled = false
    const prompt = seam.pendingPrompt(host, KEY)!
    expect(prompt.kind).toBe('unsupported')
    await expect(seam.answer(host, KEY, prompt.promptId, 'allow_once')).resolves.toMatchObject({
      reason: 'prompt_unsupported'
    })
  })

  it('throws for a conversation with no link, and refuses once connectors are off', async () => {
    const { seam, host } = await linked()
    const other = { source: 'dev' as const, externalId: 'nope' }
    expect(() => seam.pendingPrompt(host, other)).toThrow('external_conversation_not_found')
    seam.dispose('connectors_disabled')
    await expect(seam.answer(host, KEY, 'p', 'allow_once')).resolves.toEqual({
      outcome: 'refused',
      reason: 'connectors_disabled'
    })
    expect(() => seam.watch(host, () => {})).toThrow('connectors_disabled')
  })
})

describe('ExternalConversationSeam watch', () => {
  it('subscribes only while watched, and opens with a snapshot of every link', async () => {
    const { seam, host, paneListeners, hookRows } = await linked()
    expect(paneListeners.size).toBe(0)
    hookRows.set(PANE, APPROVAL)
    const seen: (ConversationSnapshot | ConversationEvent)[] = []
    const release = seam.watch(host, (event) => seen.push(event))
    expect(paneListeners.size).toBe(1)
    expect(seen).toEqual([
      {
        kind: 'snapshot',
        conversations: [
          expect.objectContaining({
            conversation: KEY,
            paneKey: PANE,
            agent: 'claude',
            working: false,
            prompt: expect.objectContaining({ kind: 'approval' })
          })
        ]
      }
    ])
    release()
    expect(paneListeners.size).toBe(0)
  })

  it('does not deliver a previous watcher’s queued finish to a new watcher', async () => {
    const { seam, host, hookRows, paneChange } = await linked()
    vi.useFakeTimers()
    try {
      const release = seam.watch(host, () => {})
      hookRows.set(PANE, hookRow({ state: 'working' }))
      paneChange({
        kind: 'observed',
        paneKey: PANE,
        phase: 'working',
        workspace: { worktreeId: WORKTREE, sshHostId: null },
        at: 100
      })
      hookRows.set(PANE, hookRow({ state: 'done', stateStartedAt: 300 }))
      paneChange(moved('working', 'done', 'turn-finished'))
      release()
      const seen: (ConversationSnapshot | ConversationEvent)[] = []
      const releaseNew = seam.watch(host, (event) => seen.push(event))
      await vi.runAllTimersAsync()
      expect(seen.map((event) => event.kind)).toEqual(['snapshot'])
      releaseNew()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports no outcome when a completed hook turn records no verdict', async () => {
    const { seam, host, hookRows, paneChange } = await linked()
    const seen: (ConversationSnapshot | ConversationEvent)[] = []
    seam.watch(host, (event) => seen.push(event))
    hookRows.set(PANE, hookRow({ state: 'working' }))
    paneChange(moved('rest', 'working', 'prompt-submitted'))
    hookRows.set(PANE, hookRow({ state: 'done', stateStartedAt: 300 }))
    paneChange(moved('working', 'done', 'turn-finished'))
    expect(seen.at(-1)).toMatchObject({ kind: 'turn-ended', stopReason: null })
  })

  it('tells a linked turn’s start, its prompt, and its end with the host’s verdict', async () => {
    const { seam, host, hookRows, paneChange } = await linked()
    const seen: ConversationEvent[] = []
    seam.watch(host, (event) => {
      if (event.kind !== 'snapshot') {
        seen.push(event)
      }
    })
    hookRows.set(PANE, hookRow({ state: 'working', turnStartedAt: 100 }))
    paneChange(moved('rest', 'working', 'prompt-submitted'))
    hookRows.set(PANE, APPROVAL)
    paneChange(moved('working', 'needs-you', 'needs-input'))
    hookRows.set(
      PANE,
      hookRow({
        state: 'done',
        stateStartedAt: 300,
        lastAssistantMessage: 'Done.',
        mainAgent: { state: 'done', stateStartedAt: 300, outcome: 'success' }
      })
    )
    paneChange(moved('needs-you', 'done', 'turn-finished'))
    expect(seen.map((event) => event.kind)).toEqual(['turn-started', 'prompt', 'turn-ended'])
    expect(seen[0]).toMatchObject({ conversation: KEY, at: 100 })
    expect(seen[1]).toMatchObject({ prompt: { kind: 'approval' } })
    expect(seen[2]).toMatchObject({
      stopReason: 'success',
      lastAssistantMessage: 'Done.',
      at: 300,
      turnId: 100
    })
  })

  it('ends a turn the user stopped with its recorded verdict, never the caller’s', async () => {
    const { seam, host, hookRows, paneChange } = await linked()
    const seen: ConversationEvent[] = []
    seam.watch(host, (event) => {
      if (event.kind !== 'snapshot') {
        seen.push(event)
      }
    })
    hookRows.set(PANE, hookRow({ state: 'working' }))
    paneChange(moved('rest', 'working', 'prompt-submitted'))
    hookRows.set(PANE, hookRow({ state: 'done', stateStartedAt: 150, interrupted: true }))
    paneChange(moved('working', 'rest', null))
    expect(seen.at(-1)).toMatchObject({ kind: 'turn-ended', stopReason: 'cancellation' })
  })

  it('tells nothing for a pane no conversation links, nor a done from before the turn', async () => {
    const { seam, host, hookRows, paneChange } = await linked()
    const seen: ConversationEvent[] = []
    seam.watch(host, (event) => {
      if (event.kind !== 'snapshot') {
        seen.push(event)
      }
    })
    hookRows.set(PANE, hookRow({ state: 'working', turnStartedAt: 500 }))
    paneChange(moved('rest', 'working', 'prompt-submitted'))
    hookRows.set(PANE, hookRow({ state: 'done', stateStartedAt: 400, sessionBoundary: false }))
    paneChange(moved('working', 'done', 'turn-finished'))
    paneChange({ ...moved('rest', 'working', 'prompt-submitted'), paneKey: 'tab-9:other' })
    expect(seen.map((event) => event.kind)).toEqual(['turn-started'])
  })

  it('tells a watcher of a conversation linked while it watches', async () => {
    const h = harness()
    const host = {
      launcher: fakeLauncher(async () => launchResult('handed-to-terminal')).launcher,
      terminal: fakeTerminal().terminal
    }
    const seen: (ConversationSnapshot | ConversationEvent)[] = []
    h.seam.watch(host, (event) => seen.push(event))
    await h.seam.start(host, KEY, 'd1', START)
    expect(seen).toEqual([
      { kind: 'snapshot', conversations: [] },
      { kind: 'linked', conversation: KEY, worktreeId: WORKTREE, paneKey: PANE, agent: 'claude' }
    ])
  })
})
