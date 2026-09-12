import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { OrcaRuntimeService } from './orca-runtime'

async function fixture(initialIncarnation: string | null = 'incarnation-a') {
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
  let incarnationId: string | undefined = initialIncarnation ?? undefined
  let spawns = 0
  runtime.setPtyController({
    spawn: async (options) => {
      const ensured = await registry.ensure({
        ...options.agentSessionEnsure!,
        spawn: async () => ({ ptyId: `synthetic-${++spawns}` })
      })
      return {
        id: ensured.owner.ptyId,
        incarnationId,
        agentSessionEnsure: ensured
      }
    },
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'claude'
  })
  const reveals: Record<string, unknown>[] = []
  runtime.setNotifier({
    revealTerminalSession: vi.fn(async (_worktree, value) => {
      reveals.push(value)
    })
  } as never)
  const internals = runtime as unknown as {
    mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    ptysById: Map<string, RuntimePtyWorktreeRecord>
    recordPtyWorktree: (
      ptyId: string,
      worktreeId: string,
      state: { incarnationId?: string | null }
    ) => void
  }
  const claim = {
    digestVersion: 1 as const,
    keyId: 'synthetic-key',
    agent: 'claude' as const,
    identityDigest: 'writer',
    worktreeScopeDigest: 'a'
  }
  const cwd = join(process.cwd(), 'incumbent-subdirectory')
  const launchConfig = { agentCommand: 'claude', agentArgs: '', agentEnv: {} }
  const first = await runtime.createTerminal('id:a', {
    agentSessionClaim: claim,
    cwd,
    presentation: 'background',
    title: 'incumbent',
    viewMode: 'chat',
    launchConfig,
    launchToken: 'synthetic-predecessor-token',
    launchAgent: 'claude'
  })
  const ptyId = first.ptyId!
  const owner = registry.list()[0]
  return {
    runtime,
    internals,
    first,
    ptyId,
    owner,
    cwd,
    launchConfig,
    reveals,
    record: internals.ptysById.get(ptyId)!,
    replace: (next: string | undefined) => {
      incarnationId = next
      registry.reconcileAuthoritative([
        { ...owner, generation: `replacement-${next ?? 'unknown'}` }
      ])
    },
    adopt: (workspace: string) =>
      runtime.createTerminal(`id:${workspace}`, {
        agentSessionClaim: { ...claim, worktreeScopeDigest: workspace },
        presentation: 'focused',
        title: 'requester',
        cwd: join(process.cwd(), 'requester'),
        viewMode: 'terminal',
        launchConfig: { ...launchConfig, agentArgs: 'requester' },
        launchToken: 'synthetic-requester-token',
        launchAgent: 'claude'
      }),
    spawns: () => spawns
  }
}

describe('terminal process metadata lifetime', () => {
  it('publishes a fresh unknown-identity launch without trusting a later unknown adoption', async () => {
    const f = await fixture(null)
    expect(f.internals.mobileSessionTabsByWorktree.get('a')!.tabs[0]).toMatchObject({
      startupCwd: f.cwd,
      viewMode: 'chat',
      title: 'incumbent'
    })
    await f.adopt('b')
    expect(f.reveals.at(-1)).toMatchObject({
      cwd: undefined,
      viewMode: undefined,
      launchToken: undefined,
      title: null
    })
  })

  it.each(['a', 'b'])(
    'preserves proven incumbent metadata on adoption from workspace %s',
    async (workspace) => {
      const f = await fixture()
      f.runtime.registerPty(f.ptyId, 'a', null, {
        ...f.owner.surface,
        incarnationId: 'incarnation-a'
      })
      f.runtime.onPtySpawned(f.ptyId, 'incarnation-a')
      const result = await f.adopt(workspace)
      expect(result).toMatchObject({
        ptyId: f.ptyId,
        worktreeId: 'a',
        title: 'incumbent'
      })
      expect(f.reveals.at(-1)).toMatchObject({
        title: 'incumbent',
        cwd: f.cwd,
        viewMode: 'chat',
        launchConfig: f.launchConfig,
        launchToken: 'synthetic-predecessor-token',
        launchAgent: 'claude'
      })
      expect(f.spawns()).toBe(1)
    }
  )

  it.each(['a', 'b'])(
    'replaces all predecessor metadata before adoption from workspace %s',
    async (workspace) => {
      const f = await fixture()
      f.replace('incarnation-b')
      f.runtime.registerPty(f.ptyId, 'a', null, {
        ...f.owner.surface,
        incarnationId: 'incarnation-b'
      })
      const result = await f.adopt(workspace)
      expect(result).toMatchObject({
        ptyId: f.ptyId,
        worktreeId: 'a',
        title: null
      })
      expect(f.reveals.at(-1)).toMatchObject({
        title: null,
        cwd: undefined,
        viewMode: undefined,
        launchConfig: undefined,
        launchToken: undefined,
        launchAgent: undefined
      })
      const published = f.internals.mobileSessionTabsByWorktree.get('a')!.tabs[0]
      expect(published).toMatchObject({
        incarnationId: 'incarnation-b',
        title: 'Terminal'
      })
      for (const key of ['startupCwd', 'viewMode', 'launchAgent']) {
        expect(published).not.toHaveProperty(key)
      }
      expect(f.record).toMatchObject({
        launchConfig: null,
        launchToken: null,
        launchAgent: null,
        title: null,
        launchSurface: undefined
      })
      expect(f.spawns()).toBe(1)
      expect(f.internals.mobileSessionTabsByWorktree.has('b')).toBe(false)
    }
  )

  it.each([
    'spawn',
    'record',
    'exit-identity',
    'unknown-registration',
    'unknown-spawn',
    'unknown-record'
  ])('retires predecessor metadata through %s before any adoption', async (path) => {
    const f = await fixture()
    f.record.lastOscTitle = 'old OSC title'
    f.record.controllerTitle = 'old controller title'
    const next = path.startsWith('unknown') ? undefined : 'incarnation-b'
    if (path.endsWith('spawn')) {
      f.runtime.onPtySpawned(f.ptyId, next)
    } else if (path.endsWith('record')) {
      f.internals.recordPtyWorktree(f.ptyId, 'a', {
        incarnationId: next ?? null
      })
    } else if (path === 'exit-identity') {
      f.runtime.acceptPtyIncarnationForExit(f.ptyId, next!)
    } else {
      f.runtime.registerPty(f.ptyId, 'a', null, f.owner.surface)
    }
    expect(f.record).toMatchObject({
      incarnationId: next ?? null,
      launchConfig: null,
      launchToken: null,
      launchIncarnationId: null,
      launchAgent: null,
      title: null,
      lastOscTitle: null,
      controllerTitle: null,
      managementTitle: null,
      launchSurface: undefined
    })
  })

  it('does not equate absent identities or reclaim metadata when identity becomes known', async () => {
    const f = await fixture()
    f.replace(undefined)
    f.runtime.registerPty(f.ptyId, 'a', null, f.owner.surface)
    const oldSurface = f.internals.mobileSessionTabsByWorktree.get('a')!.tabs[0]
    if (oldSurface.type !== 'terminal') {
      throw new Error('missing surface')
    }
    oldSurface.incarnationId = null
    await f.adopt('b')
    expect(f.reveals.at(-1)).toMatchObject({
      cwd: undefined,
      viewMode: undefined,
      launchToken: undefined,
      title: null
    })
    f.replace('incarnation-b')
    await f.adopt('b')
    expect(f.reveals.at(-1)).toMatchObject({
      cwd: undefined,
      viewMode: undefined,
      launchToken: undefined,
      title: null
    })
  })

  it('restores replacement agent identity without predecessor launch authority and ignores stale exit', async () => {
    const f = await fixture()
    f.replace('incarnation-b')
    f.runtime.registerPty(f.ptyId, 'a', null, {
      ...f.owner.surface,
      incarnationId: 'incarnation-b',
      providerReattachLaunchIdentity: {
        incarnationId: 'incarnation-b',
        launchAgent: 'codex'
      }
    })
    f.runtime.onPtyExit(f.ptyId, 0, 'incarnation-a')
    await f.adopt('b')
    expect(f.reveals.at(-1)).toMatchObject({
      launchAgent: 'codex',
      launchToken: undefined,
      launchConfig: undefined
    })
    expect(f.record.connected).toBe(true)
  })

  it('accepts replacement launch authority and retains non-identity observations within its lifetime', async () => {
    const f = await fixture()
    f.runtime.registerPty(f.ptyId, 'a', null, {
      ...f.owner.surface,
      incarnationId: 'incarnation-b',
      agentLaunchAuthority: {
        launchToken: 'synthetic-replacement-token',
        launchAgent: 'codex'
      }
    })
    f.internals.recordPtyWorktree(f.ptyId, 'a', {})
    expect(f.record).toMatchObject({
      launchToken: 'synthetic-replacement-token',
      launchIncarnationId: 'incarnation-b',
      launchAgent: 'codex',
      launchConfig: null
    })
  })
})
