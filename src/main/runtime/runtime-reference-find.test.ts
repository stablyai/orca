import { describe, expect, it, vi } from 'vitest'
import { parseWorkspaceReferenceUrl } from '../../shared/workspace-reference-identity'
import { findWorkspaceReferences, type ReferenceAgentCandidate } from './runtime-reference-find'
import type { ExecutionHostId } from '../../shared/execution-host'

function workspace(id: string, urls: string[], hostId: ExecutionHostId = 'local') {
  return {
    id,
    hostId,
    name: id,
    repo: 'api',
    kind: 'worktree' as const,
    isArchived: false,
    linkedItems: urls.map((url) => parseWorkspaceReferenceUrl(url))
  }
}

const linear = 'https://linear.app/acme/issue/STA-1234'
const jira = 'https://jira.example.com/jira/browse/STA-1234'

describe('stored reference lookup', () => {
  it('finds every source for an issue key and scopes full URLs exactly', async () => {
    const workspaces = [
      workspace('one', [linear, jira]),
      workspace('two', [linear.replace('acme', 'other')])
    ]
    const agents = vi.fn(() => new Map())
    const result = await findWorkspaceReferences({ query: 'sta-1234' }, { workspaces, agents })
    expect(result.matches.map(({ reference }) => reference.provider)).toEqual([
      'linear',
      'jira',
      'linear'
    ])
    expect(agents).toHaveBeenCalledTimes(1)
    expect(
      (await findWorkspaceReferences({ query: linear }, { workspaces, agents })).matches
    ).toHaveLength(1)
  })

  it('counts workspaces, preserves every matching source in a workspace, and excludes archives', async () => {
    const workspaces = [
      workspace('one', [linear, jira]),
      { ...workspace('archive', [linear]), isArchived: true },
      workspace('two', [linear])
    ]
    const source = { workspaces, agents: () => new Map() }
    const limited = await findWorkspaceReferences({ query: 'STA-1234', limit: 1 }, source)
    expect(limited.matches).toHaveLength(2)
    expect(limited.truncated).toBe(true)
    expect((await findWorkspaceReferences({ query: 'STA-1234', limit: 2 }, source)).truncated).toBe(
      false
    )
    expect(
      (await findWorkspaceReferences({ query: 'STA-1234', includeArchived: true }, source)).matches
    ).toHaveLength(4)
  })

  it('never infers an agent association from sharing a workspace or a hostless legacy origin', async () => {
    const linked = workspace('one', [linear, jira])
    linked.linkedItems[0].origins = [
      {
        kind: 'observed',
        hostId: 'local',
        tabId: 'tab',
        paneKey: 'pane',
        agent: 'codex',
        sessionId: 'provider-session'
      }
    ]
    linked.linkedItems[1].origins = [
      { kind: 'observed', tabId: 'tab', paneKey: 'pane' },
      { kind: 'observed', hostId: 'local', tabId: 'tab', paneKey: 'pane', agent: 'codex' }
    ]
    const agents: ReferenceAgentCandidate[] = [
      {
        agent: 'codex',
        hostId: 'local',
        paneKey: 'pane',
        terminal: 'exact-handle',
        liveness: 'live',
        sessionIds: ['provider-session']
      },
      { agent: 'codex', hostId: 'local', paneKey: 'other', liveness: 'unverifiable' },
      {
        agent: 'codex',
        hostId: 'local',
        paneKey: 'pane',
        liveness: 'live',
        sessionIds: ['replacement-session']
      }
    ]
    const result = await findWorkspaceReferences(
      { query: 'STA-1234' },
      { workspaces: [linked], agents: () => new Map([['local|one', agents]]) }
    )
    expect(result.matches[0].agents.map(({ linked }) => linked)).toEqual([true, false, false])
    expect(result.matches[1].agents.every(({ linked }) => !linked)).toBe(true)
    expect(result.matches[0].agents[0]).not.toHaveProperty('sessionIds')
  })

  it('does not link a later agent that reused the origin pane', async () => {
    const linked = workspace('one', [linear])
    linked.linkedItems[0].origins = [
      { kind: 'observed', hostId: 'local', tabId: 'tab', paneKey: 'pane', sessionId: 'first' }
    ]
    const later: ReferenceAgentCandidate = {
      agent: 'claude',
      hostId: 'local',
      paneKey: 'pane',
      terminal: 'handle',
      liveness: 'live'
    }
    const result = await findWorkspaceReferences(
      { query: linear },
      { workspaces: [linked], agents: () => new Map([['local|one', [later]]]) }
    )
    expect(result.matches[0].agents[0].linked).toBe(false)
  })

  it('searches an explicitly named archived workspace', async () => {
    const source = {
      workspaces: [{ ...workspace('old', [linear]), isArchived: true }],
      agents: () => new Map()
    }
    expect((await findWorkspaceReferences({ query: linear }, source)).matches).toEqual([])
    expect(
      (await findWorkspaceReferences({ query: linear, worktree: 'name:old' }, source)).matches
    ).toHaveLength(1)
  })

  it('keeps identical workspace IDs on different hosts isolated', async () => {
    const workspaces = [workspace('one', [linear]), workspace('one', [linear], 'ssh:build')]
    const candidate: ReferenceAgentCandidate = {
      hostId: 'ssh:build',
      liveness: 'unverifiable',
      terminal: 'remote-handle'
    }
    const result = await findWorkspaceReferences(
      { query: linear },
      { workspaces, agents: () => new Map([['ssh:build|one', [candidate]]]) }
    )
    expect(result.matches[0].agents).toEqual([])
    expect(result.matches[1].agents[0].terminal).toBe('remote-handle')
    expect(result.matches[1].workspace.hostId).toBe('ssh:build')
  })

  it('handles 1000 workspaces with 23 references each without discovering agents for misses', async () => {
    const workspaces = Array.from({ length: 1000 }, (_, i) =>
      workspace(
        String(i),
        Array.from({ length: 23 }, (_, n) => `https://github.com/acme/api/pull/${i * 23 + n + 1}`)
      )
    )
    const agents = vi.fn(() => new Map())
    const source = { workspaces, agents }
    expect((await findWorkspaceReferences({ query: 'MISSING-1' }, source)).matches).toEqual([])
    expect(agents).not.toHaveBeenCalled()
    expect(
      (await findWorkspaceReferences({ query: 'https://github.com/acme/api/pull/23000' }, source))
        .matches[0].workspace.id
    ).toBe('999')
    expect(agents).toHaveBeenCalledTimes(1)
  })

  it.each([0, -1, 1.5, Infinity])('rejects invalid limits %s', async (limit) => {
    await expect(
      findWorkspaceReferences({ query: linear, limit }, { workspaces: [], agents: () => new Map() })
    ).rejects.toThrow('positive integer')
  })

  it('rejects bare numbers and conflicting filters before inspecting agents', async () => {
    const source = { workspaces: [], agents: vi.fn(() => new Map()) }
    await expect(findWorkspaceReferences({ query: '5123' }, source)).rejects.toThrow(
      'full reference URL'
    )
    await expect(
      findWorkspaceReferences({ query: linear, worktree: 'one', repo: 'api' }, source)
    ).rejects.toThrow('either --worktree or --repo')
    expect(source.agents).not.toHaveBeenCalled()
  })
})
