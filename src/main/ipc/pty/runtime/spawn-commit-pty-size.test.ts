import { restoreProvisionalPtySize, seedPtySpawnSize } from '../spawn-options-assembly'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ptySizes } from '../delivery/visibility-state'
import { commitRuntimePtySpawn } from './spawn-commit'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

const PTY_ID = 'orca-pty-adopted'
const LIVE_GRID = { cols: 211, rows: 57 }

function makeRuntime() {
  return {
    registerPreAllocatedHandleForPty: vi.fn(),
    registerPty: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    seedHeadlessTerminal: vi.fn(),
    noteTerminalSpawnCommand: vi.fn()
  }
}

describe('runtime spawn commit: adopted agent-session claim', () => {
  afterEach(() => {
    ptySizes.delete(PTY_ID)
  })

  function makeAdoptedCtx(result: Record<string, unknown>) {
    const runtime = makeRuntime()
    const deps = { runtime, store: undefined, options: {} } as unknown as PtyRuntimeControllerDeps
    const args = { cols: 120, rows: 40, worktreeId: 'wt-1' } as unknown as RuntimePtySpawnArgs
    const ctx = createRuntimePtySpawnState(deps, args)
    ctx.result = {
      id: PTY_ID,
      ...result,
      agentSessionEnsure: {
        disposition: 'adopted',
        owner: {
          claim: { kind: 'terminal' },
          generation: 'g1',
          phase: 'live',
          ptyId: PTY_ID,
          surface: { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1', terminalHandle: 'h1' }
        }
      }
    } as unknown as typeof ctx.result
    return { runtime, ctx }
  }

  it('preserves a same-id winner grid when releasing a provisional loser seed', async () => {
    const winnerGrid = { cols: 132, rows: 45 }
    ptySizes.set(PTY_ID, { cols: 91, rows: 31 })
    const loser = {
      provisionalPtySize: seedPtySpawnSize({
        sessionId: PTY_ID,
        sessionAppId: PTY_ID,
        isFreshSessionId: true,
        requestIsUnmeasured: false,
        cols: 80,
        rows: 24
      })
    }
    expect(ptySizes.get(PTY_ID)).toEqual({ cols: 80, rows: 24 })
    const { ctx } = makeAdoptedCtx({
      isReattach: true,
      snapshotCols: winnerGrid.cols,
      snapshotRows: winnerGrid.rows
    })
    await commitRuntimePtySpawn(ctx)
    expect(ptySizes.get(PTY_ID)).toEqual(winnerGrid)

    restoreProvisionalPtySize(loser, { reattachId: PTY_ID })
    expect(loser.provisionalPtySize).toBeUndefined()
    expect(ptySizes.get(PTY_ID)).toEqual(winnerGrid)
    restoreProvisionalPtySize(loser)
    expect(ptySizes.get(PTY_ID)).toEqual(winnerGrid)
  })

  it('commits the live grid from the adoption reply before the early return', async () => {
    const { runtime, ctx } = makeAdoptedCtx({
      isReattach: true,
      launchAgent: 'codex',
      launchToken: 'owner-token',
      snapshotCols: LIVE_GRID.cols,
      snapshotRows: LIVE_GRID.rows
    })

    const reply = await commitRuntimePtySpawn(ctx)

    expect(reply.kind).toBe('adopted')
    expect(reply.result).toMatchObject({
      id: PTY_ID,
      isReattach: true,
      launchAgent: 'codex',
      launchToken: 'owner-token',
      snapshotCols: LIVE_GRID.cols,
      snapshotRows: LIVE_GRID.rows
    })
    expect(ptySizes.get(PTY_ID)).toEqual(LIVE_GRID)
    expect(runtime.reflowHeadlessTerminalToPtyGrid).toHaveBeenCalledWith(
      PTY_ID,
      LIVE_GRID.cols,
      LIVE_GRID.rows
    )
  })

  // Adoption proves attach even when relay replies omit isReattach/grid; retain cached geometry.
  it('treats an adoption without a reattach flag as an attach and keeps the held size', async () => {
    ptySizes.set(PTY_ID, LIVE_GRID)
    const { runtime, ctx } = makeAdoptedCtx({})
    ctx.provisionalPtySize = seedPtySpawnSize({
      sessionId: PTY_ID,
      sessionAppId: PTY_ID,
      isFreshSessionId: false,
      requestIsUnmeasured: false,
      cols: 120,
      rows: 40
    })

    await commitRuntimePtySpawn(ctx)

    expect(ptySizes.get(PTY_ID)).toEqual(LIVE_GRID)
    expect(runtime.reflowHeadlessTerminalToPtyGrid).toHaveBeenCalledWith(
      PTY_ID,
      LIVE_GRID.cols,
      LIVE_GRID.rows
    )
  })
})
