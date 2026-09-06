import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtySpawnResult } from '../../../providers/types'
import { ptySizes } from '../delivery/visibility-state'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { commitPtyIpcSpawn } from './spawn-commit'
import { createPtyIpcSpawnState, type PtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

const SESSION_ID = 'orca-pty-session-1'
/** What a pane that mounted while `display:none` reports: xterm's unmeasured default. */
const HIDDEN_PANE_REQUEST = { cols: 80, rows: 24 }
/** The grid the surviving daemon session is actually running at. */
const LIVE_GRID = { cols: 211, rows: 57 }

function makeRuntime() {
  return {
    seedHeadlessTerminal: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    registerPty: vi.fn(),
    cancelPendingPtyRegistration: vi.fn(),
    noteTerminalSpawnCommand: vi.fn(),
    seedTerminalRestoreTail: vi.fn(),
    registerPreAllocatedHandleForPty: vi.fn()
  }
}

function makeCtx(args: PtySpawnIpcArgs, runtime: ReturnType<typeof makeRuntime>): PtyIpcSpawnState {
  const deps = {
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    syncPtyBackgroundedDelivery: vi.fn(),
    sendPtySpawnedToRenderer: vi.fn(),
    runtime
  } as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, args)
  ctx.env = {}
  ctx.isDaemonHostSpawn = true
  ctx.effectiveSessionId = SESSION_ID
  ctx.effectiveSessionAppId = SESSION_ID
  // Mirrors spawn-preflight: a caller-supplied sessionId is an attach, never a fresh mint.
  ctx.isMintedSessionId = args.sessionId === undefined
  return ctx
}

async function runSpawn(
  args: PtySpawnIpcArgs,
  result: PtySpawnResult
): Promise<{
  runtime: ReturnType<typeof makeRuntime>
  preAttachSize: { cols: number; rows: number } | undefined
}> {
  const runtime = makeRuntime()
  const ctx = makeCtx(args, runtime)
  await buildPtyIpcSpawnOptions(ctx)
  const preAttachSize = ptySizes.get(SESSION_ID)
  ctx.result = result
  await commitPtyIpcSpawn(ctx)
  return { runtime, preAttachSize }
}

describe('spawn size cache on reattach', () => {
  afterEach(() => {
    ptySizes.delete(SESSION_ID)
    vi.restoreAllMocks()
  })

  it('records the reattached session real grid, not a hidden pane placeholder', async () => {
    const { runtime, preAttachSize } = await runSpawn(
      { ...HIDDEN_PANE_REQUEST, sessionId: SESSION_ID, initiallyHidden: true },
      {
        id: SESSION_ID,
        isReattach: true,
        snapshotCols: LIVE_GRID.cols,
        snapshotRows: LIVE_GRID.rows
      }
    )

    // Pre-attach: an unmeasured request must not be published as the live PTY's size.
    expect(preAttachSize).toBeUndefined()
    expect(ptySizes.get(SESSION_ID)).toEqual(LIVE_GRID)
    expect(runtime.reflowHeadlessTerminalToPtyGrid).toHaveBeenCalledWith(
      SESSION_ID,
      LIVE_GRID.cols,
      LIVE_GRID.rows
    )
  })

  it('records the requested grid for a genuinely fresh spawn', async () => {
    const { runtime, preAttachSize } = await runSpawn({ cols: 120, rows: 40 }, { id: SESSION_ID })

    expect(preAttachSize).toEqual({ cols: 120, rows: 40 })
    expect(ptySizes.get(SESSION_ID)).toEqual({ cols: 120, rows: 40 })
    expect(runtime.reflowHeadlessTerminalToPtyGrid).toHaveBeenCalledWith(SESSION_ID, 120, 40)
  })

  // Why: the pre-attach seed is withheld for an unmeasured attach, and a daemon that restarted
  // re-creates the session instead of attaching, so only the commit can size the model.
  it('reflows a hidden attach the daemon answered with a fresh session onto the request', async () => {
    const { runtime, preAttachSize } = await runSpawn(
      { cols: 100, rows: 30, sessionId: SESSION_ID, initiallyHidden: true },
      { id: SESSION_ID }
    )

    expect(preAttachSize).toBeUndefined()
    expect(ptySizes.get(SESSION_ID)).toEqual({ cols: 100, rows: 30 })
    expect(runtime.reflowHeadlessTerminalToPtyGrid).toHaveBeenCalledWith(SESSION_ID, 100, 30)
  })

  it('keeps the size main already held when the reattach carries no snapshot grid', async () => {
    ptySizes.set(SESSION_ID, { cols: 180, rows: 50 })

    const { preAttachSize } = await runSpawn(
      { ...HIDDEN_PANE_REQUEST, sessionId: SESSION_ID, initiallyHidden: true },
      { id: SESSION_ID, isReattach: true }
    )

    expect(preAttachSize).toEqual({ cols: 180, rows: 50 })
    expect(ptySizes.get(SESSION_ID)).toEqual({ cols: 180, rows: 50 })
  })

  it('prefers the grid the provider applied on attach over every other source', async () => {
    ptySizes.set(SESSION_ID, { cols: 180, rows: 50 })

    await runSpawn(
      { ...HIDDEN_PANE_REQUEST, sessionId: SESSION_ID, initiallyHidden: true },
      {
        id: SESSION_ID,
        isReattach: true,
        attachedGrid: { cols: 100, rows: 30 },
        snapshotCols: LIVE_GRID.cols,
        snapshotRows: LIVE_GRID.rows
      }
    )

    expect(ptySizes.get(SESSION_ID)).toEqual({ cols: 100, rows: 30 })
  })
})
