import { describe, expect, it, vi } from 'vitest'
import type { TerminalPaneAdmissionOutcome } from '../persistence/terminal-topology/terminal-pane-admission'
import { startInAdmittedPane } from './runtime-pane-admission'
import type { RuntimeStore } from './runtime-store-contract'

const SPLIT = {
  type: 'splitPane',
  workspace: 'wt-1',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  direction: 'vertical',
  newLeafId: 'leaf-new'
} as const

function storeAnswering(admit: TerminalPaneAdmissionOutcome | Error) {
  const store = {
    admitTerminalPane: vi.fn(async () => {
      if (admit instanceof Error) {
        throw admit
      }
      return admit
    }),
    withdrawTerminalPane: vi.fn(async () => null)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission path calls only these two store methods.
  return { store, runtimeStore: store as unknown as RuntimeStore }
}

describe('startInAdmittedPane', () => {
  it('writes the pane, then starts what fills it', async () => {
    const { store, runtimeStore } = storeAnswering('admitted')
    const start = vi.fn(async () => 'term-1')

    await expect(startInAdmittedPane(runtimeStore, SPLIT, 'ssh:target-1', start)).resolves.toEqual({
      outcome: 'admitted',
      result: 'term-1'
    })
    expect(store.admitTerminalPane).toHaveBeenCalledWith(SPLIT, 'ssh:target-1')
    expect(start).toHaveBeenCalledWith('admitted')
  })

  it('takes back the pane it wrote when the start fails', async () => {
    const { store, runtimeStore } = storeAnswering('admitted')

    await expect(
      startInAdmittedPane(runtimeStore, SPLIT, undefined, async () => {
        throw new Error('mount timed out')
      })
    ).rejects.toThrow('mount timed out')
    expect(store.withdrawTerminalPane).toHaveBeenCalledWith(
      { type: 'closePane', workspace: 'wt-1', tabId: 'tab-1', leafId: 'leaf-new' },
      undefined
    )
  })

  it('keeps a pane it did not write', async () => {
    const existing = storeAnswering('exists')
    await expect(
      startInAdmittedPane(existing.runtimeStore, SPLIT, undefined, async () => {
        throw new Error('spawn failed')
      })
    ).rejects.toThrow()
    expect(existing.store.withdrawTerminalPane).not.toHaveBeenCalled()
  })

  it('hands a refusal to the start, which decides', async () => {
    const { runtimeStore } = storeAnswering('pane_not_found')
    const start = vi.fn(async () => 'as-today')

    await expect(startInAdmittedPane(runtimeStore, SPLIT, undefined, start)).resolves.toEqual({
      outcome: 'pane_not_found',
      result: 'as-today'
    })
  })

  it('starts nothing after a failed write', async () => {
    const failing = storeAnswering(new Error('disk full'))
    const start = vi.fn(async () => 'as-today')

    await expect(
      startInAdmittedPane(failing.runtimeStore, SPLIT, undefined, start)
    ).rejects.toThrow('disk full')
    expect(start).not.toHaveBeenCalled()
  })
})
