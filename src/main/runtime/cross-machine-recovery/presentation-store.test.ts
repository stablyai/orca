import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RecoveryLayout } from '../../../shared/cross-machine-recovery-descriptor'
import {
  RECOVERY_PRESENTATION_RETENTION_MS,
  type RecoveryPresentationPublishParams,
  type RecoveryPresentationWorkspace
} from '../../../shared/cross-machine-recovery-presentation-types'
import {
  CROSS_MACHINE_RECOVERY_PRESENTATION_FILE,
  CrossMachineRecoveryPresentationStore
} from './presentation-store'

const WORKTREE = { kind: 'worktree', worktreeId: 'repo::/src/wt', instanceId: 'inst-1' } as const

const emptyLayout: RecoveryLayout = {
  tabs: [],
  groups: [],
  groupLayout: null,
  activeGroupId: null,
  terminalTabs: [],
  terminalLayouts: {},
  startupCwdRelative: {},
  editors: [],
  activeEditorRelativePath: null,
  browsers: [],
  activeBrowserId: null,
  activeTabType: null,
  activeTabId: null
}

function workspace(
  input: RecoveryPresentationWorkspace['input'],
  view: RecoveryLayout = emptyLayout
): RecoveryPresentationWorkspace {
  return {
    workspace: WORKTREE,
    view,
    focus: {
      isActiveWorkspace: true,
      focusedTabId: null,
      focusedLeafId: null,
      focusedPaneKey: null,
      windowFocused: false
    },
    input
  }
}

function publish(
  clientRevision: number,
  input: RecoveryPresentationWorkspace['input'] = {
    msSinceHumanInput: null,
    msSinceHumanFocus: null,
    msSinceHumanInputByPaneKey: {}
  },
  clientInstanceId = 'client-1'
): RecoveryPresentationPublishParams {
  return { clientInstanceId, clientName: 'Desk', clientRevision, workspaces: [workspace(input)] }
}

const KEY = { kind: 'worktree', worktreeId: 'repo::/src/wt', instanceId: 'inst-1' } as const

describe('CrossMachineRecoveryPresentationStore', () => {
  let directory: string
  let store: CrossMachineRecoveryPresentationStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xmr-presentation-'))
    store = new CrossMachineRecoveryPresentationStore(directory)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('stamps relative input ages on the host clock and persists them', async () => {
    const result = await store.record(
      'local-renderer',
      'local-renderer',
      publish(1, {
        msSinceHumanInput: 400,
        msSinceHumanFocus: 100,
        msSinceHumanInputByPaneKey: { 'tab-1:leaf-1': 400 }
      }),
      10_000
    )
    expect(result).toEqual({ ok: true, acknowledgedRevision: 1, hostReceivedAt: 10_000 })

    const reopened = new CrossMachineRecoveryPresentationStore(directory)
    const listed = await reopened.listForWorkspace(KEY, 10_000)
    expect(listed.preferredClientKey).toBe('local-renderer')
    expect(listed.views).toEqual([
      expect.objectContaining({
        clientKey: 'local-renderer',
        clientInstanceId: 'client-1',
        clientKind: 'local-renderer',
        hostReceivedAt: 10_000,
        lastHumanInputAt: 9_600,
        lastHumanFocusAt: 9_900
      })
    ])
  })

  it('rejects stale revisions from the same client instance only', async () => {
    await store.record('device:a', 'paired-device', publish(5), 1_000)
    expect(await store.record('device:a', 'paired-device', publish(5), 2_000)).toEqual({
      ok: false,
      reason: 'stale-revision',
      acknowledgedRevision: 5
    })
    expect(
      await store.record('device:a', 'paired-device', publish(0, undefined, 'client-2'), 3_000)
    ).toEqual({ ok: true, acknowledgedRevision: 0, hostReceivedAt: 3_000 })
  })

  it('refuses oversized publishes as too-large', async () => {
    const hugeView: RecoveryLayout = {
      ...emptyLayout,
      startupCwdRelative: { 'tab-1': 'x'.repeat(70 * 1024) }
    }
    const params: RecoveryPresentationPublishParams = {
      ...publish(1),
      workspaces: [
        workspace(
          { msSinceHumanInput: null, msSinceHumanFocus: null, msSinceHumanInputByPaneKey: {} },
          hugeView
        )
      ]
    }
    expect(await store.record('local-renderer', 'local-renderer', params, 1)).toEqual({
      ok: false,
      reason: 'too-large'
    })
  })

  it('prefers human input, then focus, then the newest publish', async () => {
    const none = {
      msSinceHumanInput: null,
      msSinceHumanFocus: null,
      msSinceHumanInputByPaneKey: {}
    }
    await store.record('device:a', 'paired-device', publish(1, none), 1_000)
    await store.record('device:b', 'paired-device', publish(1, none), 2_000)
    expect((await store.listForWorkspace(KEY, 3_000)).preferredClientKey).toBe('device:b')

    await store.record(
      'device:a',
      'paired-device',
      publish(2, { ...none, msSinceHumanFocus: 0 }),
      2_500
    )
    expect((await store.listForWorkspace(KEY, 3_000)).preferredClientKey).toBe('device:a')

    await store.record(
      'device:b',
      'paired-device',
      publish(2, { ...none, msSinceHumanInput: 2_000 }),
      2_600
    )
    expect((await store.listForWorkspace(KEY, 3_000)).preferredClientKey).toBe('device:b')
  })

  it('keeps at most sixteen clients, evicting the least recently published', async () => {
    for (let index = 0; index < 17; index += 1) {
      await store.record(`device:${index}`, 'paired-device', publish(1), 1_000 + index)
    }
    const { views } = await store.listForWorkspace(KEY, 2_000)
    expect(views).toHaveLength(16)
    expect(views.map((view) => view.clientKey)).not.toContain('device:0')
  })

  it('drops views past the retention window', async () => {
    await store.record('device:a', 'paired-device', publish(1), 1_000)
    const later = 1_000 + RECOVERY_PRESENTATION_RETENTION_MS + 1
    expect(await store.listForWorkspace(KEY, later)).toEqual({
      views: [],
      preferredClientKey: null
    })
  })

  it('ignores views of another workspace instance or kind', async () => {
    await store.record('device:a', 'paired-device', publish(1), 1_000)
    expect((await store.listForWorkspace({ ...KEY, instanceId: 'inst-2' }, 2_000)).views).toEqual(
      []
    )
    expect(
      (await store.listForWorkspace({ kind: 'folder', folderWorkspaceId: 'repo::/src/wt' }, 2_000))
        .views
    ).toEqual([])
  })

  it('drops a stored instance-less worktree row instead of matching a later incarnation', async () => {
    await store.record('device:a', 'paired-device', publish(1), 1_000)
    const filePath = join(directory, CROSS_MACHINE_RECOVERY_PRESENTATION_FILE)
    const stored = JSON.parse(await readFile(filePath, 'utf8'))
    const [kept] = stored.clients[0].workspaces
    stored.clients[0].workspaces = [
      { ...kept, workspace: { kind: 'worktree', worktreeId: 'repo::/src/wt' } },
      kept
    ]
    await writeFile(filePath, JSON.stringify(stored))

    expect((await store.listForWorkspace({ ...KEY, instanceId: 'inst-2' }, 2_000)).views).toEqual(
      []
    )
    expect((await store.listForWorkspace(KEY, 2_000)).views).toEqual([
      expect.objectContaining({ clientKey: 'device:a', clientInstanceId: 'client-1' })
    ])
  })

  it('treats a corrupt store as empty and rewrites it on the next publish', async () => {
    const filePath = join(directory, CROSS_MACHINE_RECOVERY_PRESENTATION_FILE)
    await writeFile(filePath, '{not json')
    expect((await store.listForWorkspace(KEY, 1)).views).toEqual([])
    await store.record('device:a', 'paired-device', publish(1), 1_000)
    expect(JSON.parse(await readFile(filePath, 'utf8')).version).toBe(1)
  })
})
