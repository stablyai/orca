import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { getIncumbentTerminalMetadata } from './runtime-incumbent-terminal-metadata'
import { OrcaRuntimeService } from './orca-runtime'

function fixture() {
  const runtime = new OrcaRuntimeService({
    getSettings: () => ({
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    }),
    getRepos: () => [],
    getRepo: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getProjects: () => []
  } as never)
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: async (selector: string) => ({
      id: selector.replace(/^id:/, ''),
      path: process.cwd(),
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
  })
  const registry = new ClaimedAgentPtyOwnerRegistry()
  let spawns = 0
  runtime.setPtyController({
    spawn: async (options) => {
      const ensured = await registry.ensure({
        ...options.agentSessionEnsure!,
        spawn: async () => ({ ptyId: `synthetic-${++spawns}` })
      })
      return {
        id: ensured.owner.ptyId,
        incarnationId: 'incumbent-incarnation',
        agentSessionEnsure: ensured
      }
    },
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'claude'
  })
  const reveal = vi.fn(async () => {})
  runtime.setNotifier({ revealTerminalSession: reveal } as never)
  const internals = runtime as unknown as {
    mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    ptysById: Map<string, RuntimePtyWorktreeRecord>
  }
  const claim = {
    digestVersion: 1 as const,
    keyId: 'synthetic-key',
    agent: 'claude' as const,
    identityDigest: 'writer',
    worktreeScopeDigest: 'a'
  }
  return { runtime, internals, claim, reveal, spawns: () => spawns }
}

describe('incumbent terminal publication metadata', () => {
  it.each([false, true])(
    'preserves launch provenance through adoption and reveal (deferred=%s)',
    async (deferred) => {
      const { runtime, internals, claim, reveal, spawns } = fixture()
      const cwd = join(process.cwd(), 'incumbent-subdirectory')
      const first = await runtime.createTerminal('id:a', {
        agentSessionClaim: claim,
        cwd,
        presentation: 'background',
        title: 'incumbent',
        viewMode: 'chat',
        deferMobileSessionPublish: deferred
      })
      const second = await runtime.createTerminal('id:b', {
        agentSessionClaim: { ...claim, worktreeScopeDigest: 'b' },
        cwd: join(process.cwd(), 'requester'),
        presentation: 'focused',
        title: 'requester',
        viewMode: 'terminal'
      })
      expect(second).toMatchObject({
        ptyId: first.ptyId,
        worktreeId: 'a',
        title: 'incumbent'
      })
      expect(spawns()).toBe(1)
      expect(internals.mobileSessionTabsByWorktree.get('a')?.tabs[0]).toMatchObject({
        startupCwd: cwd,
        title: 'incumbent',
        viewMode: 'chat',
        ptyId: first.ptyId
      })
      expect((await runtime.listMobileSessionTabs('id:a')).tabs[0]).toMatchObject({
        startupCwd: cwd,
        title: 'incumbent',
        viewMode: 'chat'
      })
      expect(internals.mobileSessionTabsByWorktree.has('b')).toBe(false)
      expect(reveal).toHaveBeenLastCalledWith(
        'a',
        expect.objectContaining({ cwd, title: 'incumbent', viewMode: 'chat' })
      )
    }
  )

  it('does not invent requester title or cwd for an incumbent with no launch metadata', async () => {
    const { runtime, internals, claim } = fixture()
    const first = await runtime.createTerminal('id:a', {
      agentSessionClaim: claim,
      presentation: 'background'
    })
    const record = internals.ptysById.get(first.ptyId!)!
    delete record.launchSurface
    const surface = internals.mobileSessionTabsByWorktree.get('a')!.tabs[0]
    if (surface.type !== 'terminal') {
      throw new Error('missing terminal')
    }
    surface.startupCwd = join(process.cwd(), 'recovered')
    const second = await runtime.createTerminal('id:b', {
      agentSessionClaim: { ...claim, worktreeScopeDigest: 'b' },
      presentation: 'background',
      title: 'requester',
      cwd: join(process.cwd(), 'requester')
    })
    expect(second.title).not.toBe('requester')
    expect(internals.mobileSessionTabsByWorktree.get('a')?.tabs[0]).toMatchObject({
      startupCwd: surface.startupCwd
    })
  })
  it('fences prior incarnation metadata and preserves explicit root launch intent', async () => {
    const { runtime, internals, claim } = fixture()
    const first = await runtime.createTerminal('id:a', {
      agentSessionClaim: claim,
      presentation: 'background'
    })
    const record = internals.ptysById.get(first.ptyId!)!
    const tabs = internals.mobileSessionTabsByWorktree.get('a')!.tabs
    const surface = tabs[0]
    if (surface.type !== 'terminal') {
      throw new Error('missing terminal')
    }
    surface.startupCwd = join(process.cwd(), 'stale')
    expect(
      getIncumbentTerminalMetadata(record, tabs, surface.parentTabId, surface.leafId).cwd
    ).toBeUndefined()
    runtime.registerPty(first.ptyId!, 'a', null, {
      tabId: surface.parentTabId,
      leafId: surface.leafId,
      incarnationId: 'replacement'
    })
    surface.incarnationId = 'old'
    expect(
      getIncumbentTerminalMetadata(record, tabs, surface.parentTabId, surface.leafId)
    ).toMatchObject({ cwd: undefined, viewMode: undefined })
  })
})
