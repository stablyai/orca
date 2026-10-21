import { describe, expect, it, vi } from 'vitest'
import type { RuntimeStore } from './runtime-store-contract'
import { spawnInAdmittedPane } from './runtime-pane-admission'
import {
  bindingOf,
  PaneStartStatuses,
  paneStartFactsOf,
  withPaneStartFacts
} from './pane-start-statuses'
import {
  joinPublishedLayout,
  splitPublishedLayout
} from '../../shared/workspace-layout/workspace-layout-records'
import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

const ARGS = {
  cols: 80,
  rows: 24,
  worktreeId: 'wt-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111'
}
const PANE_KEY = `${ARGS.tabId}:${ARGS.leafId}`

function storeAnswering(admit: 'admitted' | 'exists') {
  const store = {
    admitTerminalPane: vi.fn(async () => admit),
    withdrawTerminalPane: vi.fn(async () => null)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission path calls only these two store methods.
  return { store, runtimeStore: store as unknown as RuntimeStore }
}

const UNBOUND = bindingOf({})

function statuses() {
  const changed = vi.fn()
  return { changed, register: new PaneStartStatuses(changed) }
}

describe('a start into a pane main holds', () => {
  it('shows the pane starting until its terminal starts', async () => {
    const { register, changed } = statuses()
    const { runtimeStore } = storeAnswering('exists')
    let seen: unknown
    await spawnInAdmittedPane(
      runtimeStore,
      {
        spawn: vi.fn(async () => {
          seen = register.get(PANE_KEY, UNBOUND)
          return { id: 'pty-1' }
        })
      },
      { ...ARGS, startStatus: { sink: register, keepOnFailure: false } }
    )
    expect(seen).toEqual({ status: 'starting' })
    expect(register.get(PANE_KEY, UNBOUND)).toBeNull()
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('keeps the pane when its start fails, showing why', async () => {
    const { register } = statuses()
    const { store, runtimeStore } = storeAnswering('exists')
    await expect(
      spawnInAdmittedPane(
        runtimeStore,
        {
          spawn: vi.fn(async () => {
            throw new Error('shell not found')
          })
        },
        { ...ARGS, startStatus: { sink: register, keepOnFailure: false } }
      )
    ).rejects.toThrow('shell not found')
    expect(register.get(PANE_KEY, UNBOUND)).toEqual({ status: 'failed', reason: 'shell not found' })
    expect(store.withdrawTerminalPane).not.toHaveBeenCalled()
  })

  it('keeps a pane the create wrote only when asked to; otherwise takes it back as today', async () => {
    const failing = {
      spawn: vi.fn(async () => {
        throw new Error('no pty')
      })
    }
    const kept = storeAnswering('admitted')
    const { register } = statuses()
    await expect(
      spawnInAdmittedPane(kept.runtimeStore, failing, {
        ...ARGS,
        startStatus: { sink: register, keepOnFailure: true }
      })
    ).rejects.toThrow('no pty')
    expect(kept.store.withdrawTerminalPane).not.toHaveBeenCalled()
    expect(register.get(PANE_KEY, UNBOUND)?.status).toBe('failed')

    const taken = storeAnswering('admitted')
    const untouched = statuses()
    await expect(
      spawnInAdmittedPane(taken.runtimeStore, failing, {
        ...ARGS,
        startStatus: { sink: untouched.register, keepOnFailure: false }
      })
    ).rejects.toThrow('no pty')
    expect(taken.store.withdrawTerminalPane).toHaveBeenCalledTimes(1)
    expect(untouched.register.get(PANE_KEY, UNBOUND)).toBeNull()
  })
})

describe('a pane’s start status in the published layout', () => {
  const layout: PublishedWorkspaceLayout = {
    worktreeId: 'wt-1',
    groups: [{ id: 'g-1', tabIds: ['tab-1'] }],
    tabs: [
      {
        id: 'tab-1',
        kind: 'terminal',
        entityId: 'tab-1',
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        createdAt: 1,
        customTitle: null,
        color: null,
        terminal: {
          root: { type: 'leaf', leafId: ARGS.leafId },
          panes: [{ leafId: ARGS.leafId }]
        }
      }
    ],
    editorFiles: [],
    browserTabs: []
  }

  it('rides the pane’s binding record, never its tree, bound to a terminal or not', () => {
    const facts = paneStartFactsOf(layout, {
      paneStartFact: () => ({ status: 'failed', reason: 'no pty' })
    })
    const shown = withPaneStartFacts(layout, facts)
    const records = splitPublishedLayout(shown)
    expect(records.paneTrees[0]!.panes).toEqual([{ leafId: ARGS.leafId }])
    expect(records.bindings).toEqual([
      { leafId: ARGS.leafId, status: 'failed', statusReason: 'no pty' }
    ])
    expect(joinPublishedLayout(records)).toEqual(shown)

    const bound = {
      ...layout,
      tabs: [
        {
          ...layout.tabs[0]!,
          terminal: { ...layout.tabs[0]!.terminal!, panes: [{ leafId: ARGS.leafId, ptyId: 'p' }] }
        }
      ]
    }
    // A restart into a pane still bound to its old terminal: the status says that one is not live.
    const restarting = withPaneStartFacts(
      bound,
      paneStartFactsOf(bound, { paneStartFact: () => ({ status: 'starting' }) })
    )
    expect(splitPublishedLayout(restarting).bindings).toEqual([
      { leafId: ARGS.leafId, ptyId: 'p', status: 'starting' }
    ])
    expect(paneStartFactsOf(bound, { paneStartFact: () => null })).toEqual([null])
  })

  it('ends a status once its pane binds again by any path', () => {
    const { register } = statuses()
    register.set(PANE_KEY, { status: 'failed', reason: 'no pty' })
    const dead = bindingOf({ ptyId: 'old', ptyGeneration: 1 })
    expect(register.get(PANE_KEY, dead)).toEqual({ status: 'failed', reason: 'no pty' })
    expect(register.get(PANE_KEY, dead)?.status).toBe('failed')
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'new', ptyGeneration: 2 }))).toBeNull()
    expect(register.get(PANE_KEY, dead)).toBeNull()
  })

  it('ends it when the pane binds live again under the same terminal id (a restore)', () => {
    const { register } = statuses()
    register.set(PANE_KEY, { status: 'starting' })
    // Every bind raises the pane's generation, a same-id respawn included.
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'p', ptyGeneration: 1 }))?.status).toBe(
      'starting'
    )
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'p', ptyGeneration: 2 }))).toBeNull()
  })
})
