import { describe, expect, it, vi } from 'vitest'
import { spawnInAdmittedPane } from './runtime-pane-admission'
import { PaneOwnerContentionError } from '../ipc/pty/pane/pane-spawn-operation'
import type { RuntimeStore } from './runtime-store-contract'
import { bindingOf } from './pane-live-facts'
import { PaneResumeOutcomes, PaneStartStatuses } from './pane-start-statuses'

import type { PaneResumeOutcome } from '../../shared/workspace-layout/workspace-layout-published'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function outcomes() {
  const changed = vi.fn()
  return { changed, register: new PaneResumeOutcomes(changed) }
}

describe("a pane's resume outcome (layout-owner build)", () => {
  it('waits past the pane’s old bind when the start keeps its terminal id', () => {
    const { register } = outcomes()
    register.set(PANE_KEY, 'restored', { ptyId: 'pty-1', afterGeneration: 4 })

    // The same PTY id with an old generation still identifies the pre-start binding.
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
            // Commit the pane bind after the report, as spawn does.
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

  it('waits for a bind newer than the one the pane had when the start began', async () => {
    const { register } = outcomes()
    await start(register, true, 4)
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-1', ptyGeneration: 4 }))).toBeNull()
    expect(register.get(PANE_KEY, bindingOf({ ptyId: 'pty-1', ptyGeneration: 5 }))).toBe('restored')
  })

  it('waits past the old bind of a pane this process never bound (a relaunch resume)', async () => {
    const { register } = outcomes()
    await start(register, true, undefined)
    // The saved binding keeps its id; only a newer generation can reveal the new fact.
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
    // Same-id SSH reattach can preserve the binding without raising generation.
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
})
