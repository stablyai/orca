import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../../shared/constants'
import {
  REPO_UPDATE_EXECUTION_HOST_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import type { Repo } from '../../../../shared/repo-types'
import {
  closeTestStores,
  createStore,
  testState,
  writeDataFile
} from '../../../persistence-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { REPO_METHODS } from './repo'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-repo-update-owner-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

function repo(suffix: 'a' | 'b'): Repo {
  return {
    id: 'shared-id',
    displayName: 'Shared',
    path: `/receiver/${suffix}`,
    executionHostId: `ssh:private-${suffix}`,
    kind: 'folder',
    badgeColor: '#737373',
    addedAt: 1
  }
}

function fixture(rows: readonly Repo[]) {
  writeDataFile({ ...getDefaultPersistedState(testState.dir), repos: rows })
  const store = createStore()
  const runtime = new OrcaRuntimeService(store)
  const update = vi.spyOn(store, 'updateRepo')
  const runtimeUpdate = vi.spyOn(runtime, 'updateRepo')
  const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })
  return { store, runtime, update, runtimeUpdate, dispatcher }
}

async function dispatchUpdate(dispatcher: RpcDispatcher, params: Record<string, unknown>) {
  const replies: unknown[] = []
  await dispatcher.dispatchStreaming(
    { id: 'update', authToken: 'owned-test', method: 'repo.update', params },
    (frame) => replies.push(JSON.parse(frame)),
    {
      clientKind: 'runtime',
      pairedDeviceId: 'owned-repo-update-device',
      clientCapabilities: [...RUNTIME_CAPABILITIES]
    }
  )
  expect(replies).toHaveLength(1)
  return replies[0]
}

describe('registered repo update owner resolution', () => {
  it('advertises qualified repo updates from the runtime status', () => {
    const { runtime } = fixture([repo('b')])
    expect(runtime.getStatus().capabilities).toContain(
      REPO_UPDATE_EXECUTION_HOST_RUNTIME_CAPABILITY
    )
  })

  it.each([false, true])('updates only qualified B (B first: %s)', async (bFirst) => {
    const rows = bFirst ? [repo('b'), repo('a')] : [repo('a'), repo('b')]
    const { store, update, dispatcher } = fixture(rows)
    const before = structuredClone(store.getRepos())
    const updates = { displayName: 'Renamed B' }
    const result = await dispatchUpdate(dispatcher, {
      repo: 'shared-id',
      executionHostId: 'ssh:private-b',
      updates
    })
    expect(result).toMatchObject({
      ok: true,
      result: { repo: { ...repo('b'), ...updates } }
    })
    expect(update).toHaveBeenCalledExactlyOnceWith('shared-id', updates, 'ssh:private-b')
    expect(store.getRepos()).toEqual(
      before.map((row) => (row.executionHostId === 'ssh:private-b' ? { ...row, ...updates } : row))
    )
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: true })
    expect(createStore().getRepos()).toEqual(store.getRepos())
  })

  it.each(['id:shared-id', 'name:Shared', 'path:/receiver/b'])(
    'qualifies the existing %s selector',
    async (selector) => {
      const { store, update, dispatcher } = fixture([repo('a'), repo('b')])
      const before = structuredClone(store.getRepos())
      const result = await dispatchUpdate(dispatcher, {
        repo: selector,
        executionHostId: 'ssh:private-b',
        updates: { displayName: 'Selected B' }
      })
      expect(result).toMatchObject({
        ok: true,
        result: { repo: { path: '/receiver/b', executionHostId: 'ssh:private-b' } }
      })
      expect(update).toHaveBeenCalledExactlyOnceWith(
        'shared-id',
        { displayName: 'Selected B' },
        'ssh:private-b'
      )
      expect(store.getRepos()[0]).toEqual(before[0])
    }
  )

  it.each([false, true])('keeps an unqualified unique path on B (B first: %s)', async (bFirst) => {
    const rows = bFirst ? [repo('b'), repo('a')] : [repo('a'), repo('b')]
    const { store, update, runtimeUpdate, dispatcher } = fixture(rows)
    const before = structuredClone(store.getRepos())
    const updates = { displayName: 'Path-selected B' }
    expect(await dispatchUpdate(dispatcher, { repo: 'path:/receiver/b', updates })).toMatchObject({
      ok: true,
      result: { repo: { path: '/receiver/b', ...updates } }
    })
    expect(runtimeUpdate).toHaveBeenCalledExactlyOnceWith('path:/receiver/b', updates)
    expect(update).toHaveBeenCalledExactlyOnceWith('shared-id', updates, 'ssh:private-b')
    expect(store.getRepos()).toEqual(
      before.map((row) => (row.executionHostId === 'ssh:private-b' ? { ...row, ...updates } : row))
    )
  })

  it('preserves the unique legacy update call and durable local row', async () => {
    const { store, update, runtimeUpdate, dispatcher } = fixture([
      { ...repo('b'), executionHostId: 'local' }
    ])
    const updates = { displayName: 'Legacy rename' }
    expect(await dispatchUpdate(dispatcher, { repo: 'shared-id', updates })).toMatchObject({
      ok: true,
      result: { repo: { displayName: 'Legacy rename', executionHostId: 'local' } }
    })
    expect(runtimeUpdate).toHaveBeenCalledExactlyOnceWith('shared-id', updates)
    expect(update).toHaveBeenCalledExactlyOnceWith('shared-id', updates, 'local')
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: true })
    expect(createStore().getRepos()).toEqual(store.getRepos())
  })

  it('keeps sanitized fields, hooks and explicit clears on the qualified row', async () => {
    const inherited = {
      ghAccount: { host: 'github.com', user: 'Alice' },
      sourceControlAi: { enabled: false },
      externalWorktreeDiscoverySuppressedAt: 99,
      worktreeBasePath: '../old'
    }
    const { store, runtime, update, dispatcher } = fixture([
      { ...repo('a'), ...inherited },
      { ...repo('b'), ...inherited }
    ])
    const before = structuredClone(store.getRepos())
    const hookSettings = {
      mode: 'override' as const,
      scripts: { setup: 'prepare', archive: 'cleanup' }
    }
    expect(
      await dispatchUpdate(dispatcher, {
        repo: 'shared-id',
        executionHostId: 'ssh:private-b',
        updates: {
          ghAccount: { host: ' GitHub.COM ', user: ' Bob ' },
          sourceControlAi: null,
          externalWorktreeDiscoverySuppressedAt: null,
          hookSettings
        }
      })
    ).toMatchObject({ ok: true })
    expect(update).toHaveBeenCalledExactlyOnceWith(
      'shared-id',
      {
        ghAccount: { host: 'github.com', user: 'Bob' },
        sourceControlAi: null,
        externalWorktreeDiscoverySuppressedAt: undefined,
        hookSettings
      },
      'ssh:private-b'
    )
    await runtime.updateRepo(
      'shared-id',
      { ghAccount: null, worktreeBasePath: undefined },
      'ssh:private-b'
    )
    expect(store.getRepos()[0]).toEqual(before[0])
    const selected = store.getRepos()[1]
    expect(selected?.hookSettings).toMatchObject(hookSettings)
    for (const field of [
      'ghAccount',
      'sourceControlAi',
      'externalWorktreeDiscoverySuppressedAt',
      'worktreeBasePath'
    ]) {
      expect(selected).not.toHaveProperty(field)
    }
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: true })
    expect(createStore().getRepos()).toEqual(store.getRepos())
  })

  it.each([false, true])('refuses ambiguous legacy IDs (B first: %s)', async (bFirst) => {
    const { store, update, dispatcher } = fixture(
      bFirst ? [repo('b'), repo('a')] : [repo('a'), repo('b')]
    )
    const before = structuredClone(store.getRepos())
    expect(
      await dispatchUpdate(dispatcher, {
        repo: 'shared-id',
        updates: { displayName: 'Do not save' }
      })
    ).toMatchObject({ ok: false, error: { code: 'selector_ambiguous' } })
    expect(update).not.toHaveBeenCalled()
    expect(store.getRepos()).toEqual(before)
  })

  it.each([
    { selector: 'shared-id', host: 'ssh:missing', code: 'repo_not_found' },
    { selector: 'path:/receiver/a', host: 'ssh:private-b', code: 'repo_not_found' },
    { selector: 'path:/receiver/b', host: 'invalid', code: 'invalid_argument' },
    { selector: 'path:/receiver/b', host: null, code: 'invalid_argument' }
  ])('refuses $host/$selector before writing', async ({ selector, host, code }) => {
    const { store, update, dispatcher } = fixture([repo('a'), repo('b')])
    const before = structuredClone(store.getRepos())
    expect(
      await dispatchUpdate(dispatcher, {
        repo: selector,
        executionHostId: host,
        updates: { displayName: 'Do not save' }
      })
    ).toMatchObject({ ok: false, error: { code } })
    expect(update).not.toHaveBeenCalled()
    expect(store.getRepos()).toEqual(before)
  })

  it.each(['duplicate', 'contradictory'] as const)(
    'refuses a %s owner catalog before writing',
    async (kind) => {
      const rows =
        kind === 'duplicate'
          ? [repo('a'), repo('b'), { ...repo('b'), path: '/receiver/duplicate-b' }]
          : [{ ...repo('a'), connectionId: 'different-host' }, repo('b')]
      const { store, update, dispatcher } = fixture(rows)
      const before = structuredClone(store.getRepos())
      expect(before).toHaveLength(rows.length)
      expect(
        await dispatchUpdate(dispatcher, {
          repo: 'path:/receiver/b',
          executionHostId: 'ssh:private-b',
          updates: { displayName: 'Do not save' }
        })
      ).toMatchObject({ ok: false, error: { code: 'repo_not_found' } })
      expect(update).not.toHaveBeenCalled()
      expect(store.getRepos()).toEqual(before)
    }
  )
})
