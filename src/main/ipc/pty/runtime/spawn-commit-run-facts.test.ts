import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithRuntimeId } from '../../../runtime/orca-runtime-runtime-id'
import { TerminalIntentionalStops } from '../../../runtime/terminal-intentional-stops'
import { TerminalRunFactsRegister } from '../../../runtime/terminal-run-facts'
import { ptySizes } from '../delivery/visibility-state'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { commitRuntimePtySpawn } from './spawn-commit'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

const PTY_ID = 'orca-pty-run-facts'
const INCARNATION_ID = 'inc-run-facts'

const ADOPTED = {
  disposition: 'adopted',
  owner: {
    claim: { kind: 'terminal' },
    generation: 'g1',
    phase: 'live',
    ptyId: PTY_ID,
    surface: { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1', terminalHandle: 'h1' }
  }
}

async function commit(
  result: Record<string, unknown>,
  facts = new TerminalRunFactsRegister(),
  intentionalPtyStops = new TerminalIntentionalStops()
) {
  const runtime = {
    terminalRunFacts: facts,
    intentionalPtyStops,
    // Why the real method: the case under test is what the runtime does with each commit.
    noteTerminalSpawnCommit: OrcaRuntimeWithRuntimeId.prototype.noteTerminalSpawnCommit,
    registerPreAllocatedHandleForPty: vi.fn(),
    registerPty: vi.fn(),
    cancelPendingPtyRegistration: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    seedHeadlessTerminal: vi.fn(),
    noteTerminalSpawnCommand: vi.fn()
  }
  const ports = { runtime, store: undefined, options: {}, sendPtySpawnedToRenderer: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commit reads only the ports above; store-less deps skip every persistence branch.
  const deps = ports as unknown as PtyRuntimeControllerDeps
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a worktree-less spawn needs only its grid.
  const args = { cols: 120, rows: 40 } as unknown as RuntimePtySpawnArgs
  const ctx = createRuntimePtySpawnState(deps, args)
  const spawned = { id: PTY_ID, incarnationId: INCARNATION_ID, ...result }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each case sets the spawn-result fields the commit reads.
  ctx.result = spawned as unknown as typeof ctx.result
  await commitRuntimePtySpawn(ctx)
  return facts.read(PTY_ID, INCARNATION_ID)
}

describe('runtime spawn commit: run facts', () => {
  afterEach(() => {
    ptySizes.delete(PTY_ID)
    ptyOwnership.delete(PTY_ID)
    ptyIncarnationById.delete(PTY_ID)
  })

  it('records a new process as a fresh spawn', async () => {
    expect((await commit({})).freshSpawn).toBe(true)
  })

  it('never reads an SSH adoption that omits isReattach as fresh', async () => {
    expect((await commit({ agentSessionEnsure: ADOPTED })).freshSpawn).toBe(false)
  })

  it('never reads a cold restore as fresh', async () => {
    const coldRestore = { scrollback: 'prior output', cwd: '/tmp' }

    expect((await commit({ coldRestore })).freshSpawn).toBe(false)
  })

  it('keeps a process run facts when the same incarnation commits again', async () => {
    const facts = new TerminalRunFactsRegister()
    await commit({}, facts)
    facts.recordUserInput(PTY_ID, 100)

    expect(await commit({ isReattach: true }, facts)).toEqual({
      freshSpawn: true,
      firstUserInputAt: 100
    })
  })

  it('lets the new process supersede a landed stop that no exit pinned', async () => {
    const stops = new TerminalIntentionalStops()
    stops.mark(PTY_ID, 'reversible', null)(true)

    await commit({}, new TerminalRunFactsRegister(), stops)

    expect(stops.claimExit(PTY_ID, INCARNATION_ID)).toEqual([])
  })
})
