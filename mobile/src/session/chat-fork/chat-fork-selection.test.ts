import { describe, expect, it } from 'vitest'
import {
  chatForkRoute,
  resolveChatForkSelection,
  type ChatForkHost,
  type ChatForkSource
} from './chat-fork-selection'

const source: ChatForkSource = {
  hostId: 'desk',
  agent: 'claude',
  usageLimited: false,
  canExport: true,
  canNewWorktree: true,
  canSubagent: true
}

const hosts: ChatForkHost[] = [
  { hostId: 'desk', status: 'ready', canImport: true, canFirstMessage: true },
  { hostId: 'laptop', status: 'ready', canImport: true, canFirstMessage: true },
  { hostId: 'old', status: 'needs-update', canImport: false, canFirstMessage: true }
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

  it('switches to another agent on another host when this host cannot export the chat', () => {
    const selection = resolve({
      source: { ...source, canExport: false },
      picks: { hostId: 'laptop', agent: 'claude' }
    })
    expect(selection.agent).toBe('codex')
    expect(selection.agentChoices).toContainEqual({ agent: 'claude', enabled: false })
  })

  it('ignores a host that cannot take the fork', () => {
    expect(resolve({ picks: { hostId: 'old' } }).hostId).toBe('desk')
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

describe('chatForkRoute', () => {
  it('copies, relays or recaps by host and agent', () => {
    expect(chatForkRoute(source, { hostId: 'desk', agent: 'claude' })).toBe('copy')
    expect(chatForkRoute(source, { hostId: 'laptop', agent: 'claude' })).toBe('relay')
    expect(chatForkRoute(source, { hostId: 'desk', agent: 'codex' })).toBe('recap')
  })
})
