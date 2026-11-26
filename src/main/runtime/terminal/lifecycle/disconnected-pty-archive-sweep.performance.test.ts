import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { partialRuntimeStore } from '../../construction/test-context/runtime-store-partial-fixture'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

type SweepInternals = {
  ptysById: Map<string, RuntimePtyWorktreeRecord & { disconnectedAt?: number | null }>
  terminalIdentity: { setPtyConnected(record: RuntimePtyWorktreeRecord, value: boolean): void }
  pruneDisconnectedPtyRecords(): void
  isSleptPanePty(pty: RuntimePtyWorktreeRecord): boolean
}

it.each([150, 1_500])(
  'unrelated archive sweeps re-classify none of %i retained sleepers, and a new exit still caps ordinary archives',
  (sleepers) => {
    const runtime = new OrcaRuntimeService(partialRuntimeStore({}))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the archive sweep and its classifier are the work under test.
    const internals = runtime as unknown as SweepInternals
    const disconnect = (ptyId: string, at: number) => {
      runtime.registerPty(ptyId, 'wt', null)
      const pty = internals.ptysById.get(ptyId)!
      internals.terminalIdentity.setPtyConnected(pty, false)
      pty.disconnectedAt = at
    }
    const slept = new Set<string>()
    for (let index = 0; index < sleepers; index++) {
      slept.add(`slept-${index}`)
      disconnect(`slept-${index}`, index)
    }
    for (let index = 0; index < 128; index++) {
      disconnect(`ended-${index}`, sleepers + index)
    }
    const classify = vi
      .spyOn(internals, 'isSleptPanePty')
      .mockImplementation((pty) => slept.has(pty.ptyId))
    internals.pruneDisconnectedPtyRecords()
    classify.mockClear()

    for (let sweep = 0; sweep < 10; sweep++) {
      internals.pruneDisconnectedPtyRecords()
    }
    expect(classify).not.toHaveBeenCalled()

    disconnect('ended-new', sleepers + 1_000)
    internals.pruneDisconnectedPtyRecords()
    expect(internals.ptysById.has('ended-0')).toBe(false)
    expect(internals.ptysById.has('ended-new')).toBe(true)
    expect([...slept].every((ptyId) => internals.ptysById.has(ptyId))).toBe(true)
  }
)
