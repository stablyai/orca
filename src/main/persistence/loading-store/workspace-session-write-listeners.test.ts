import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import {
  WorkspaceLayoutStream,
  type WorkspaceLayoutEvent
} from '../../runtime/workspace-layout-stream'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import { fixture } from './profile-state-delayed-authority-fixture'
import type { Store } from './store'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const WT = 'repo-local::/fixture/local'
const SSH_HOST: ExecutionHostId = 'ssh:target-1'
const binding = {
  worktreeId: WT,
  tabId: 'observed-tab',
  leafId: TEST_LEAF_1,
  ptyId: 'observed-pty',
  incarnationId: 'observed-incarnation'
}

type Mode = 'none' | 'publisher' | 'throwing'

/** The first partition holding the workspace's rows owns it. */
function homeOf(store: Store, key: string): ExecutionHostId | null {
  return (
    store
      .getWorkspaceSessionHostIds()
      .find((hostId) => Object.hasOwn(store.getWorkspaceSession(hostId).tabsByWorktree, key)) ??
    null
  )
}

function hostSession(store: Store): WorkspaceSessionState {
  return {
    ...store.getWorkspaceSession(SSH_HOST),
    tabsByWorktree: {
      'repo-ssh::/remote/wt': [
        {
          id: 'ssh-tab',
          worktreeId: 'repo-ssh::/remote/wt',
          ptyId: 'ssh-pty',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'ssh-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_2 },
        activeLeafId: TEST_LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_2]: 'ssh-pty' }
      }
    }
  }
}

/** Every write shape the publisher hooks: debounced set and patch, durable bind and retire, a failed write's rollback, removal. */
async function runScenario(mode: Mode) {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { store, authority, readState } = await fixture()
  const pushes: WorkspaceLayoutEvent[] = []
  if (mode !== 'none') {
    const stream = new WorkspaceLayoutStream({
      store: () => store,
      homeHostId: (key) => homeOf(store, key)
    })
    stream.subscribe(
      mode === 'publisher'
        ? (event) => pushes.push(event)
        : () => {
            throw new Error('listener failed')
          }
    )
  }
  const snapshots: unknown[] = []
  const step = async (run: () => unknown) => {
    await run()
    await store.flushPendingOrThrowAsync()
    snapshots.push(structuredClone(store.getWorkspaceSession()))
  }

  await step(() => store.persistPtyBinding(binding))
  await step(() => store.patchWorkspaceSession({ activeTabId: binding.tabId }))
  await step(() => store.persistPtyBinding({ ...binding, leafId: TEST_LEAF_2, ptyId: 'split-pty' }))
  await step(() => store.setWorkspaceSession(hostSession(store), SSH_HOST))
  await step(async () => {
    authority.failNextWrite()
    await store
      .persistPtyBinding({ ...binding, ptyId: 'failed-pty', incarnationId: 'failed' })
      .catch((error: unknown) => error instanceof ProfileStateWriterError || error)
  })
  await step(() => store.retirePtyBinding(binding))
  await step(() => store.removeWorkspaceSessionStateForWorktree(WT))
  return {
    saved: withStableFixtureIds({
      captures: authority.captures,
      snapshots,
      persisted: readState()
    }),
    pushes,
    warnings: warn.mock.calls.filter(([message]) => String(message).includes('workspace-layout'))
      .length
  }
}

/** Each fixture store gets a fresh temp dir and leaf ids; rename them by first appearance. */
function withStableFixtureIds(value: unknown): unknown {
  const fixed = new Set([TEST_LEAF_1, TEST_LEAF_2])
  const renamed = new Map<string, string>()
  const json = JSON.stringify(value)
    .replace(/orca-worker-coordination-[A-Za-z0-9]+/g, 'orca-worker-coordination-dir')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, (id) => {
      if (fixed.has(id)) {
        return id
      }
      if (!renamed.has(id)) {
        renamed.set(id, `fixture-leaf-${renamed.size}`)
      }
      return renamed.get(id)!
    })
  return JSON.parse(json)
}

describe('workspace session write observers are inert', () => {
  it('leave saved state and write order identical, even when they throw', async () => {
    const baseline = await runScenario('none')
    const observed = await runScenario('publisher')
    const throwing = await runScenario('throwing')

    expect(JSON.stringify(baseline.saved)).toContain('split-pty')
    expect(observed.pushes.length).toBeGreaterThan(0)
    expect(observed.saved).toEqual(baseline.saved)
    expect(throwing.saved).toEqual(baseline.saved)
    expect(throwing.warnings).toBe(1)
  })

  it('publishes each committed layout change, including durable binds and the removal', async () => {
    const { pushes } = await runScenario('publisher')

    const local = pushes.filter((event) => event.key === WT)
    const bindings = local.map((event) =>
      event.type === 'workspace'
        ? event.layout.tabs
            .find((tab) => tab.entityId === binding.tabId)
            ?.terminal?.panes.map((pane) => [pane.leafId, pane.ptyId])
        : 'removed'
    )
    expect(bindings).toEqual([
      [[TEST_LEAF_1, 'observed-pty']],
      [
        [TEST_LEAF_1, 'observed-pty'],
        [TEST_LEAF_2, 'split-pty']
      ],
      // Memory is published before the disk write; the failed write's rollback republishes.
      [
        [TEST_LEAF_1, 'failed-pty'],
        [TEST_LEAF_2, 'split-pty']
      ],
      [
        [TEST_LEAF_1, 'observed-pty'],
        [TEST_LEAF_2, 'split-pty']
      ],
      [
        [TEST_LEAF_1, undefined],
        [TEST_LEAF_2, 'split-pty']
      ],
      'removed'
    ])
    const ssh = pushes.filter((event) => event.key === 'repo-ssh::/remote/wt')
    expect(ssh).toEqual([expect.objectContaining({ type: 'workspace' })])
    // Published from the SSH partition that owns it: its tabs run on that host.
    expect(ssh[0]?.type === 'workspace' && ssh[0].layout.tabs[0]?.executionHostId).toBe(SSH_HOST)
  })
})
