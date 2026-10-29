import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { ConversationEvent } from './external-conversation-events'
import { harness } from './external-conversation-seam.test-fixture'
import {
  fakeLauncher,
  fakeTerminal,
  launchResult,
  PANE,
  WORKTREE
} from './external-conversation.test-fixture'

const KEY = { source: 'dev', externalId: 'rejection' } as const
const APPROVAL: AgentStatusIpcPayload = {
  state: 'waiting',
  prompt: '',
  agentType: 'claude',
  paneKey: PANE,
  connectionId: null,
  receivedAt: 1,
  stateStartedAt: 200,
  interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'ls' } }),
  programStatus: { state: 'blocked', observedAt: 1 }
}

async function watching(agent: 'claude' | 'codex' = 'claude') {
  const h = harness()
  const fake = fakeTerminal()
  const host = {
    launcher: fakeLauncher(async () => launchResult('handed-to-terminal')).launcher,
    terminal: fake.terminal
  }
  await h.seam.start(host, KEY, 'start', {
    agent,
    target: { kind: 'existing', worktree: `id:${WORKTREE}` },
    prompt: 'first'
  })
  h.hookRows.set(PANE, APPROVAL)
  const ended: ConversationEvent[] = []
  const stopWatching = h.seam.watch(host, (event) => {
    if (event.kind === 'turn-ended') {
      ended.push(event)
    }
  })
  const idle = (overrides: Partial<AgentStatusIpcPayload> = {}): void => {
    h.hookRows.set(PANE, {
      ...APPROVAL,
      programStatus: { state: 'idle', observedAt: Date.now() },
      ...overrides
    })
    h.paneChange({
      kind: 'observed',
      paneKey: PANE,
      workspace: { worktreeId: WORKTREE, sshHostId: null },
      phase: 'needs-you',
      at: Date.now()
    })
  }
  return { ...h, fake, host, ended, stopWatching, idle }
}

describe('cancel rejection settlement evidence', () => {
  it('settles an idle observation that arrives before the write acknowledgment', async () => {
    const h = await watching()
    const send = h.fake.terminal.sendTerminal.getMockImplementation()
    if (!send) {
      throw new Error('missing test transport')
    }
    h.fake.terminal.sendTerminal.mockImplementationOnce(async (...args) => {
      const result = await send(...args)
      h.idle()
      expect(h.ended).toEqual([])
      return result
    })
    await h.seam.cancel(h.host, KEY, 'cancel')
    expect(h.ended).toEqual([expect.objectContaining({ stopReason: 'cancellation' })])
    h.idle()
    expect(h.ended).toHaveLength(1)
  })

  it('requires the same process and prompt, not just the same state timestamp', async () => {
    for (const replaceProcess of [false, true]) {
      const h = await watching()
      await h.seam.cancel(h.host, KEY, 'cancel')
      if (replaceProcess) {
        h.fake.replace()
      }
      h.idle(
        replaceProcess
          ? {}
          : { interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'pwd' } }) }
      )
      expect(h.ended).toEqual([])
    }
  })

  it('requires a blocked-to-idle observation rather than an already idle facet', async () => {
    const h = await watching()
    h.idle()
    await h.seam.cancel(h.host, KEY, 'cancel')
    h.idle()
    expect(h.ended).toEqual([])
  })

  it('does not retain a late acknowledgment after the last watcher leaves', async () => {
    const h = await watching()
    const send = h.fake.terminal.sendTerminal.getMockImplementation()
    if (!send) {
      throw new Error('missing test transport')
    }
    h.fake.terminal.sendTerminal.mockImplementationOnce(async (...args) => {
      const result = await send(...args)
      h.stopWatching()
      return result
    })
    await h.seam.cancel(h.host, KEY, 'cancel')
    h.seam.watch(h.host, (event) => {
      if (event.kind === 'turn-ended') {
        h.ended.push(event)
      }
    })
    h.idle()
    expect(h.ended).toEqual([])
  })
})
