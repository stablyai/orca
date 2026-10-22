import { describe, expect, it, vi } from 'vitest'
import { spawnInAdmittedPane } from './runtime-pane-admission'
import { PaneOwnerContentionError } from '../ipc/pty/pane/pane-spawn-operation'
import type { RuntimeStore } from './runtime-store-contract'
import { bindingOf } from './pane-live-facts'
import {
  PaneResumeOutcomes,
  PaneStartStatuses,
  paneStartFactsOf,
  withPaneStartFacts
} from './pane-start-statuses'
import { splitPublishedLayout } from '../../shared/workspace-layout/workspace-layout-records'
import type {
  PaneResumeOutcome,
  PublishedWorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-published'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function outcomes() {
  const changed = vi.fn()
  return { changed, register: new PaneResumeOutcomes(changed) }
}

describe("a pane's resume outcome (layout-owner build)", () => {
  it('shows once the pane binds the terminal it names, not before', () => {
    const { changed, register } = outcomes()
    register.set(PANE_KEY, 'restored', { ptyId: 'pty-new' })
    expect(changed).toHaveBeenCalledOnce()

    // The start's bind write has not landed: the pane still shows its old terminal.
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-old', ptyGeneration: 1 }))).toBeNull()
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-new', ptyGeneration: 2 }))).toBe(
      'restored'
    )
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-new', ptyGeneration: 2 }))).toBe(
      'restored'
    )
  })

  it('waits past the pane’s old bind when the start keeps its terminal id', () => {
    const { register } = outcomes()
    register.set(PANE_KEY, 'restored', { ptyId: 'pty-1', afterGeneration: 4 })

    // The frame before the start's bind still shows the old terminal under the same id.
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-1', ptyGeneration: 4 }))).toBeNull()
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-1', ptyGeneration: 5 }))).toBe('restored')
  })

  it('ends when the pane binds again, a same-id respawn included', () => {
    const { register } = outcomes()
    register.set(PANE_KEY, 'resume-unavailable', { ptyId: 'pty-1' })
    const first = bindingOf({ ptyId: 'pty-1', ptyGeneration: 1 })
    expect(register.get(PANE_KEY, first)).toBe('resume-unavailable')

    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-1', ptyGeneration: 2 }))).toBeNull()
    expect(register.get(PANE_KEY, first)).toBeNull()
  })

  it("rides the pane's binding record, never its tree", () => {
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
            root: { type: 'leaf', leafId: LEAF_ID },
            panes: [{ leafId: LEAF_ID, ptyId: 'pty-1', ptyGeneration: 1 }]
          }
        }
      ],
      editorFiles: [],
      browserTabs: []
    }
    const { register } = outcomes()
    register.set(PANE_KEY, 'restored', { ptyId: 'pty-1' })

    const records = splitPublishedLayout(
      withPaneStartFacts(
        layout,
        paneStartFactsOf(layout, {
          paneResumeOutcome: (paneKey, binding) => register.get(paneKey, binding)
        })
      )
    )

    expect(records.paneTrees[0]!.panes).toEqual([{ leafId: LEAF_ID }])
    expect(records.bindings).toEqual([
      { leafId: LEAF_ID, ptyId: 'pty-1', ptyGeneration: 1, resumeOutcome: 'restored' }
    ])
  })
})

describe("main's start records a resume outcome only when it wakes the pane's record", () => {
  const RECONNECT = {
    cols: 80,
    rows: 24,
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: LEAF_ID,
    paneSpawnOperation: { mustExist: true }
  }

  async function start(
    register: PaneResumeOutcomes,
    resumesSleepingRecord: boolean,
    boundGeneration?: number,
    bind?: () => void,
    { bumps = true }: { bumps?: boolean } = {}
  ) {
    const sink = new PaneStartStatuses(() => {})
    let generation = boundGeneration
    const store = { getPtyBindingGeneration: () => generation }
    await spawnInAdmittedPane(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a reconnect's start reads only the pane's bind generation.
      store as unknown as RuntimeStore,
      {
        spawn: vi.fn(
          async (args: {
            onResumeOutcome?: (ptyId: string, outcome: PaneResumeOutcome) => void
          }) => {
            args.onResumeOutcome?.('pty-1', 'restored')
            // The pane's bind is written after the report, as the spawn commit does.
            bind?.()
            if (bumps) {
              generation = (boundGeneration ?? 0) + 1
            }
            return { id: 'pty-1' }
          }
        )
      },
      {
        ...RECONNECT,
        startStatus: { sink, keepOnFailure: false, resumeOutcomes: register, resumesSleepingRecord }
      }
    )
  }

  it('records the outcome of a wake from the record, and none for any other resume', async () => {
    const woke = outcomes().register
    await start(woke, true)
    expect(woke.peek(PANE_KEY)).toBe('restored')

    // A Session History, phone or forked-chat resume: the window showed no banner for those.
    const other = outcomes().register
    await start(other, false)
    expect(other.peek(PANE_KEY)).toBeNull()
  })

  it('waits for a bind newer than the one the pane had when the start began', async () => {
    const { register } = outcomes()
    await start(register, true, 4)
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-1', ptyGeneration: 4 }))).toBeNull()
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-1', ptyGeneration: 5 }))).toBe('restored')
  })

  it('waits past the old bind of a pane this process never bound (a relaunch resume)', async () => {
    const { register } = outcomes()
    await start(register, true, undefined)
    // A frame before the bind still shows the pane's saved terminal, which kept its id.
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-1' }))).toBeNull()
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-1', ptyGeneration: 1 }))).toBe('restored')
  })

  it('clears the outcome when the start fails after its spawn reported it', async () => {
    const { register } = outcomes()
    await expect(
      start(register, true, 2, () => {
        throw new Error('terminal_split_source_not_found')
      })
    ).rejects.toThrow('terminal_split_source_not_found')
    expect(register.peek(PANE_KEY)).toBeNull()
  })

  it('keeps the outcome on the binding the pane shows when its bind wrote nothing new', async () => {
    // An SSH relay's same-id reattach matches the stored binding, so no generation is bumped.
    const { register } = outcomes()
    await start(register, true, 3, undefined, { bumps: false })
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-1', ptyGeneration: 3 }))).toBe('restored')
  })

  it("leaves the winner's outcome when another owner won the pane", async () => {
    const { register } = outcomes()
    await expect(
      start(register, true, 2, () => {
        register.set(PANE_KEY, 'restored', { ptyId: 'pty-winner' })
        throw new PaneOwnerContentionError()
      })
    ).rejects.toBeInstanceOf(PaneOwnerContentionError)
    expect(register.peek(PANE_KEY)).toBe('restored')
  })

  it("ends the pane's earlier outcome when a later start begins", async () => {
    const { register } = outcomes()
    register.set(PANE_KEY, 'resume-unavailable', { ptyId: 'pty-0' })
    await start(register, false)
    expect(register.peek(PANE_KEY)).toBeNull()
  })
})
