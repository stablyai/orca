import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithRuntimeId } from '../../../runtime/orca-runtime-runtime-id'
import { TerminalIntentionalStops } from '../../../runtime/terminal-intentional-stops'
import { TerminalRunFactsRegister } from '../../../runtime/terminal-run-facts'
import { ptySizes } from '../delivery/visibility-state'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { commitPtyIpcSpawn } from './spawn-commit'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcDeps } from './spawn-types'

const PTY_ID = 'orca-ipc-pty-run-facts'
const INCARNATION_ID = 'inc-ipc-run-facts'

async function commit(persistPtyBinding: ReturnType<typeof vi.fn>) {
  const facts = new TerminalRunFactsRegister()
  const stops = new TerminalIntentionalStops()
  stops.mark(PTY_ID, 'reversible', null)(true)
  const runtime = {
    terminalRunFacts: facts,
    intentionalPtyStops: stops,
    // Why the real method: the case under test is what the runtime does with each commit.
    noteTerminalSpawnCommit: OrcaRuntimeWithRuntimeId.prototype.noteTerminalSpawnCommit,
    registerPreAllocatedHandleForPty: vi.fn(),
    registerPty: vi.fn(),
    cancelPendingPtyRegistration: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    seedHeadlessTerminal: vi.fn(),
    noteTerminalSpawnCommand: vi.fn()
  }
  const ports = {
    runtime,
    store: { persistPtyBinding },
    options: {},
    sendPtySpawnedToRenderer: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commit reads only the ports above, and the store only for its binding save.
  const deps = ports as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    cols: 120,
    rows: 40
  })
  ctx.validatedLeafId = 'leaf-1'
  ctx.provider = { ...ctx.provider, shutdown: vi.fn().mockResolvedValue(undefined) }
  ctx.result = { id: PTY_ID, incarnationId: INCARNATION_ID }
  const outcome = await commitPtyIpcSpawn(ctx).then(
    () => 'committed',
    () => 'discarded'
  )
  return { outcome, facts, stops }
}

describe('renderer spawn commit: run facts', () => {
  afterEach(() => {
    ptySizes.delete(PTY_ID)
    ptyOwnership.delete(PTY_ID)
    ptyIncarnationById.delete(PTY_ID)
  })

  it('records a committed spawn and lets it supersede a landed stop no exit pinned', async () => {
    const { outcome, facts, stops } = await commit(vi.fn().mockResolvedValue(true))

    expect(outcome).toBe('committed')
    expect(facts.read(PTY_ID, INCARNATION_ID).freshSpawn).toBe(true)
    expect(stops.claimExit(PTY_ID, INCARNATION_ID)).toEqual([])
  })

  it('records nothing for a spawn discarded because its binding save failed', async () => {
    const persistPtyBinding = vi.fn().mockRejectedValue(new Error('disk full'))
    const { outcome, facts, stops } = await commit(persistPtyBinding)

    expect(outcome).toBe('discarded')
    expect(persistPtyBinding).toHaveBeenCalledOnce()
    expect(facts.read(PTY_ID, INCARNATION_ID).freshSpawn).toBe(false)
    expect(stops.claimExit(PTY_ID, INCARNATION_ID)).toEqual(['reversible'])
  })
})
