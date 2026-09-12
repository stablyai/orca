import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { toRuntimeExecutionHostId } from '../shared/execution-host'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import { createStore, makeTerminalTab, readDataFile, testState } from './persistence-test-harness'
import type { Store } from './persistence'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const GONE = toRuntimeExecutionHostId('gone')
const KEPT = toRuntimeExecutionHostId('kept')
const WORKSPACE = folderWorkspaceKey('folder-1')
const stores: Store[] = []

function store(): Store {
  const instance = createStore()
  stores.push(instance)
  return instance
}

function session(name: string) {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKSPACE]: [makeTerminalTab({ id: name, worktreeId: WORKSPACE, ptyId: `remote:${name}` })]
    }
  }
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-retired-host-session-'))
})

afterEach(async () => {
  for (const instance of stores.splice(0)) await instance.flushAsync()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('retired runtime host sessions', () => {
  it('removes a persisted partition while preserving other hosts and folder tabs', () => {
    const instance = store()
    for (const host of [GONE, KEPT, 'local', 'ssh:builder']) {
      instance.setWorkspaceSession(session(host), host)
    }
    const survivors = [KEPT, 'local', 'ssh:builder'].map((host) =>
      instance.getWorkspaceSession(host)
    )
    instance.deleteHostWorkspaceSession(GONE)
    instance.flushOrThrow()
    expect(
      (readDataFile() as { workspaceSessionsByHostId: object }).workspaceSessionsByHostId
    ).not.toHaveProperty(GONE)
    expect(instance.getWorkspaceSession(GONE).tabsByWorktree).toEqual({})
    expect(
      [KEPT, 'local', 'ssh:builder'].map((host) => instance.getWorkspaceSession(host))
    ).toEqual(survivors)
    expect(store().getWorkspaceSession(GONE).tabsByWorktree).toEqual({})
  })

  it.each(['full', 'patch-topology', 'patch-scalar', 'before-unload'] as const)(
    'rejects a late %s write after removal',
    (kind) => {
      const instance = store()
      const stale = session('stale')
      instance.setWorkspaceSession(stale, GONE)
      instance.deleteHostWorkspaceSession(GONE)
      if (kind === 'full') instance.setWorkspaceSession(stale, GONE)
      if (kind === 'patch-topology')
        instance.patchWorkspaceSession({ tabsByWorktree: stale.tabsByWorktree }, GONE)
      if (kind === 'patch-scalar') instance.patchWorkspaceSession({ activeTabId: 'stale' }, GONE)
      if (kind === 'before-unload') instance.stageWorkspaceSessionBeforeUnload(stale, GONE)
      instance.flushOrThrow()
      expect(instance.getWorkspaceSessionHostIds()).not.toContain(GONE)
      expect(store().getWorkspaceSession(GONE).tabsByWorktree).toEqual({})
    }
  )

  it('fences first-time saves queued before removal and leaves a newly paired ID writable', () => {
    const instance = store()
    instance.deleteHostWorkspaceSession(GONE)
    instance.setWorkspaceSession(session('late-first-save'), GONE)
    instance.setWorkspaceSession(session('new-pairing'), KEPT)
    expect(instance.getWorkspaceSessionHostIds()).not.toContain(GONE)
    expect(instance.getWorkspaceSession(KEPT).tabsByWorktree[WORKSPACE]).toHaveLength(1)
  })

  it('rejects a late terminal binding while allowing the surviving host to bind', () => {
    const instance = store()
    instance.deleteHostWorkspaceSession(GONE)
    const binding = { worktreeId: WORKSPACE, tabId: 'late', leafId: 'pane:1', ptyId: 'late-pty' }
    expect(instance.persistPtyBinding(binding, GONE)).toBe(false)
    expect(instance.persistPtyBinding(binding, KEPT)).toBe(true)
    expect(instance.getWorkspaceSessionHostIds()).not.toContain(GONE)
    expect(instance.getWorkspaceSession(KEPT).tabsByWorktree[WORKSPACE]).toHaveLength(1)
  })

  it('prunes legacy orphan partitions once and fences their later writes', () => {
    const instance = store()
    for (let index = 0; index < 512; index++) {
      instance.setWorkspaceSession(
        session(`tab-${index}`),
        toRuntimeExecutionHostId(`gone-${index}`)
      )
    }
    instance.setWorkspaceSession(session('kept'), KEPT)
    instance.setWorkspaceSession(session('ssh'), 'ssh:builder')
    expect(instance.pruneOrphanedRuntimeHostWorkspaceSessions(new Set(['kept']))).toHaveLength(512)
    expect(instance.pruneOrphanedRuntimeHostWorkspaceSessions(new Set(['kept']))).toEqual([])
    instance.setWorkspaceSession(session('late'), toRuntimeExecutionHostId('gone-0'))
    expect(instance.getWorkspaceSessionHostIds().sort()).toEqual(
      [KEPT, 'local', 'ssh:builder'].sort()
    )
  })

  it.each(['local', 'ssh:builder', '', null, undefined])(
    'preserves non-runtime partition %s',
    (host) => {
      const instance = store()
      instance.setWorkspaceSession(session('preserved'), host)
      const original = instance.getWorkspaceSession(host)
      instance.deleteHostWorkspaceSession(host)
      expect(instance.getWorkspaceSession(host)).toEqual(original)
    }
  )
})
