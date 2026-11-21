import { describe, expect, it } from 'vitest'
import {
  resolveChatForkSelection,
  type ChatForkHost,
  type ChatForkSource,
  type ChatForkWorkspace
} from './chat-fork-selection'

const source: ChatForkSource = {
  hostId: 'desk',
  agent: 'claude',
  surface: 'chat',
  usageLimited: false,
  canCopy: true,
  canExport: true,
  canNewWorktree: true,
  canSubagent: true
}

const hosts: ChatForkHost[] = [
  {
    hostId: 'desk',
    status: 'ready',
    canImport: true,
    canFirstMessage: true,
    canLaunchTerminal: true
  },
  {
    hostId: 'laptop',
    status: 'ready',
    canImport: true,
    canFirstMessage: true,
    canLaunchTerminal: true
  },
  {
    hostId: 'chat-only',
    status: 'ready',
    canImport: false,
    canFirstMessage: true,
    canLaunchTerminal: false
  },
  {
    hostId: 'old',
    status: 'needs-update',
    canImport: false,
    canFirstMessage: false,
    canLaunchTerminal: false
  }
]

function resolve(overrides: Partial<Parameters<typeof resolveChatForkSelection>[0]> = {}) {
  return resolveChatForkSelection({
    source,
    preset: null,
    hosts,
    targetAgents: ['claude', 'codex'],
    picks: {},
    ...overrides
  })
}

describe('resolveChatForkSelection', () => {
  it('forks a chat whose history cannot be copied into the same agent as a recap', () => {
    const selection = resolve({
      source: { ...source, agent: 'codex', canCopy: false, canExport: false }
    })
    expect(selection).toMatchObject({ agent: 'codex', path: 'recap', sameAgentRecap: true })
  })

  it('defaults to a copy of this chat beside it, on this host, with the same agent', () => {
    const selection = resolve()
    expect(selection).toMatchObject({
      hostId: 'desk',
      workspace: { kind: 'this' },
      agent: 'claude',
      runAs: 'open',
      ready: true
    })
  })

  it('preselects another agent while the chat is at its usage limit', () => {
    expect(resolve({ source: { ...source, usageLimited: true } }).agent).toBe('codex')
  })

  it('keeps the same agent at the usage limit when no other agent can start', () => {
    const selection = resolve({
      source: { ...source, usageLimited: true },
      targetAgents: ['claude']
    })
    expect(selection.agent).toBe('claude')
  })

  it('starts a subagent preset in a new worktree', () => {
    expect(resolve({ preset: 'subagent' })).toMatchObject({
      workspace: { kind: 'new' },
      runAs: 'subagent'
    })
  })

  it('waits for a workspace on another host and never offers a subagent there', () => {
    const selection = resolve({ picks: { hostId: 'laptop', runAs: 'subagent' } })
    expect(selection).toMatchObject({
      hostId: 'laptop',
      workspace: null,
      runAs: 'open',
      subagentOffered: false,
      ready: false
    })
  })

  it('recaps the same agent on another host when this host cannot export the chat', () => {
    const selection = resolve({
      source: { ...source, canExport: false },
      picks: { hostId: 'laptop', agent: 'claude' }
    })
    expect(selection).toMatchObject({ agent: 'claude', path: 'recap', openAs: 'chat' })
  })

  it('starts another agent on a host that doesn’t list this chat’s own', () => {
    const selection = resolve({ picks: { hostId: 'laptop' }, targetAgents: ['codex'] })
    expect(selection).toMatchObject({ agent: 'codex', path: 'recap' })
    expect(selection.agentChoices).toContainEqual({ agent: 'claude', enabled: false })
  })

  it('relays the exact copy to another host, and to a terminal on this one', () => {
    expect(resolve({ picks: { hostId: 'laptop' } })).toMatchObject({ path: 'relay' })
    expect(resolve({ picks: { openAs: 'terminal' } })).toMatchObject({
      path: 'relay',
      openAs: 'terminal',
      subagentOffered: false,
      ready: true
    })
  })

  it('opens a terminal chat as its own kind, and copies it exactly as a chat', () => {
    const terminal = { ...source, surface: 'terminal' as const, canSubagent: false }
    expect(resolve({ source: terminal })).toMatchObject({ path: 'same', openAs: 'terminal' })
    expect(resolve({ source: terminal, picks: { openAs: 'chat' } })).toMatchObject({
      path: 'relay',
      openAs: 'chat'
    })
  })

  it('recaps onto a host that can’t import, and offers only the kinds it can start', () => {
    const workspace: ChatForkWorkspace = {
      kind: 'existing',
      hostId: 'chat-only',
      worktreeId: 'wt',
      name: 'wt'
    }
    const selection = resolve({ picks: { hostId: 'chat-only', workspace, openAs: 'terminal' } })
    expect(selection).toMatchObject({
      agent: 'claude',
      path: 'recap',
      openAs: 'chat',
      surfaces: { chat: true, terminal: false },
      recapScope: 'history',
      ready: true
    })
  })

  it('opens another agent as a recap in a terminal, with the context picked', () => {
    const selection = resolve({
      picks: { agent: 'codex', openAs: 'terminal', recapScope: 'current' }
    })
    expect(selection).toMatchObject({
      path: 'recap',
      openAs: 'terminal',
      recapScope: 'current',
      sameAgentRecap: false
    })
  })

  it('blocks Fork when the agent can open as neither kind', () => {
    const selection = resolve({
      source: { ...source, agent: 'codex', canCopy: false, canExport: false },
      hosts: hosts.map((host) =>
        host.hostId === 'desk' ? { ...host, canLaunchTerminal: false } : host
      ),
      targetAgents: ['claude']
    })
    expect(selection).toMatchObject({ openAs: null, ready: false })
  })

  it('keeps a picked host that can no longer take the fork, and blocks Fork', () => {
    const workspace: ChatForkWorkspace = {
      kind: 'existing',
      hostId: 'old',
      worktreeId: 'wt',
      name: 'wt'
    }
    const selection = resolve({ picks: { hostId: 'old', workspace } })
    expect(selection).toMatchObject({ hostId: 'old', workspace, ready: false })
  })

  it('drops a workspace picked on the host the person moved away from', () => {
    const selection = resolve({
      picks: {
        hostId: 'desk',
        workspace: { kind: 'existing', hostId: 'laptop', worktreeId: 'wt', name: 'wt' }
      }
    })
    expect(selection.workspace).toEqual({ kind: 'this' })
  })
})
