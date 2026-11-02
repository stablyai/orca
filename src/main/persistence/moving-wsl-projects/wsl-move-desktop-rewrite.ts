/**
 * The desktop rewrite stage of a committed WSL move: `destination-committed` → `client-rewritten`.
 * Each registered store is rewritten, made durable, then recorded in the journal's ledger; a
 * crash or failure redoes only the stores not recorded yet, on the next pass.
 */
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import type {
  WslMovePendingRendererRewrite,
  WslMoveRecordStoreRewrittenRequest,
  WslMoveRecordStoreRewrittenResult
} from '../../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import { wslHostsGateOpen } from '../../wsl/wsl-host-gate'
import { listWslMoveCutovers, writeWslMoveCutover } from './wsl-move-cutover-journal'
import {
  isWslMoveDesktopRewriteRegistryComplete,
  listWslMoveDesktopRewriteStores,
  pendingWslMoveDesktopRewriteStores,
  type WslMoveDesktopRewriteContext
} from './wsl-move-desktop-rewrite-stores'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'

// Passes are serialized, so one hung store would otherwise stall every later pass in the process.
export const WSL_MOVE_REWRITE_STORE_TIMEOUT_MS = 30_000

export type WslMoveDesktopRewritePassOptions = {
  userDataPath: string
  /** Per `run` and per `flush`; defaults to WSL_MOVE_REWRITE_STORE_TIMEOUT_MS. */
  storeTimeoutMs?: number
  warn?: (message: string) => void
}

function rewriteContext(cutover: Readonly<WslMoveCutover>): WslMoveDesktopRewriteContext {
  return {
    cutover,
    rewritePath: createUncToLinuxPathRewriter(cutover.manifest.source.distro),
    destinationHostId: toRuntimeExecutionHostId(cutover.destinationEnvironmentId)
  }
}

/** Fresh from disk: the ledger write must extend what is there now, not what a pass started with. */
function readCommittedCutover(userDataPath: string, migrationId: string): WslMoveCutover | null {
  const cutover = listWslMoveCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  return cutover?.phase === 'destination-committed' ? cutover : null
}

function appendLedgerEntry(userDataPath: string, cutover: WslMoveCutover, storeId: string): void {
  writeWslMoveCutover(userDataPath, {
    ...cutover,
    rewrittenStores: [...cutover.rewrittenStores, storeId],
    updatedAt: new Date().toISOString()
  })
}

/** Advances once every registered store, main and renderer, is in the ledger. */
function advanceWhenRewritten(userDataPath: string, migrationId: string): void {
  // Stores not registered yet would never run on a move that already left the rewrite phase.
  if (!isWslMoveDesktopRewriteRegistryComplete()) {
    return
  }
  const cutover = readCommittedCutover(userDataPath, migrationId)
  if (!cutover || pendingWslMoveDesktopRewriteStores(cutover.rewrittenStores).length > 0) {
    return
  }
  writeWslMoveCutover(userDataPath, {
    ...cutover,
    phase: 'client-rewritten',
    updatedAt: new Date().toISOString()
  })
}

/** A timed-out step fails like a thrown one; its late result is ignored, never recorded. */
async function withStoreTimeout(
  step: () => Promise<void> | void,
  timeoutMs: number,
  label: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
  })
  try {
    await Promise.race([Promise.resolve().then(step), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function rewriteMainStores(
  options: WslMoveDesktopRewritePassOptions,
  migrationId: string
): Promise<void> {
  const { userDataPath } = options
  const initial = readCommittedCutover(userDataPath, migrationId)
  if (!initial) {
    return
  }
  for (const store of pendingWslMoveDesktopRewriteStores(initial.rewrittenStores)) {
    if (store.side !== 'main') {
      continue
    }
    const before = readCommittedCutover(userDataPath, migrationId)
    if (!before || before.rewrittenStores.includes(store.id)) {
      continue
    }
    const timeoutMs = options.storeTimeoutMs ?? WSL_MOVE_REWRITE_STORE_TIMEOUT_MS
    await withStoreTimeout(() => store.run(rewriteContext(before)), timeoutMs, `${store.id} run`)
    await withStoreTimeout(() => store.flush(), timeoutMs, `${store.id} flush`)
    const current = readCommittedCutover(userDataPath, migrationId)
    if (!current) {
      throw new Error('wsl_move_record_missing')
    }
    if (!current.rewrittenStores.includes(store.id)) {
      appendLedgerEntry(userDataPath, current, store.id)
    }
  }
  advanceWhenRewritten(userDataPath, migrationId)
}

async function runPass(options: WslMoveDesktopRewritePassOptions): Promise<void> {
  const warn = options.warn ?? ((message: string) => console.warn(message))
  let committed: string[]
  try {
    committed = listWslMoveCutovers(options.userDataPath)
      .filter((cutover) => cutover.phase === 'destination-committed')
      .map((cutover) => cutover.migrationId)
  } catch (error) {
    warn(`[wsl-move] Could not read the move journal for the desktop rewrite: ${describe(error)}`)
    return
  }
  for (const migrationId of committed) {
    try {
      await rewriteMainStores(options, migrationId)
    } catch (error) {
      // No ledger entry for the failed store: the next pass retries it, and nothing else changes.
      warn(`[wsl-move] Desktop rewrite of move ${migrationId} paused: ${describe(error)}`)
    }
  }
}

let passQueue: Promise<void> = Promise.resolve()

/** Never throws; passes are serialized so two cannot rewrite the same store at once. */
export function runWslMoveDesktopRewritePass(
  options: WslMoveDesktopRewritePassOptions
): Promise<void> {
  const next = passQueue.then(() => runPass(options))
  passQueue = next
  return next
}

/** Startup, and after a move commits: a no-op unless the internal WSL hosts gate is open. */
export function runGatedWslMoveDesktopRewritePass(
  options: WslMoveDesktopRewritePassOptions
): Promise<void> {
  return wslHostsGateOpen() ? runWslMoveDesktopRewritePass(options) : Promise.resolve()
}

/** Committed moves still waiting on renderer-side stores; empty with the gate closed. */
export function listPendingWslMoveRendererRewrites(
  userDataPath: string
): WslMovePendingRendererRewrite[] {
  if (!wslHostsGateOpen()) {
    return []
  }
  try {
    return listWslMoveCutovers(userDataPath).flatMap((cutover) => {
      if (cutover.phase !== 'destination-committed') {
        return []
      }
      const storeIds = pendingWslMoveDesktopRewriteStores(cutover.rewrittenStores)
        .filter((store) => store.side === 'renderer')
        .map((store) => store.id)
      if (storeIds.length === 0) {
        return []
      }
      const { source } = cutover.manifest
      return [
        {
          migrationId: cutover.migrationId,
          storeIds,
          destinationEnvironmentId: cutover.destinationEnvironmentId,
          destinationHostId: toRuntimeExecutionHostId(cutover.destinationEnvironmentId),
          distro: source.distro,
          scopeRepoIds: [...source.scopeRepoIds],
          scopeFolderWorkspaceIds: [...source.scopeFolderWorkspaceIds]
        }
      ]
    })
  } catch (error) {
    console.warn(`[wsl-move] Could not list pending renderer rewrites: ${describe(error)}`)
    return []
  }
}

/**
 * The renderer finished (and persisted) one of its stores for a committed move. Independent of
 * main-store order: it may land before, between or after the main pass's entries.
 */
export function recordWslMoveRendererStoreRewritten(
  userDataPath: string,
  request: WslMoveRecordStoreRewrittenRequest
): WslMoveRecordStoreRewrittenResult {
  if (!wslHostsGateOpen()) {
    return { recorded: false, reason: 'gated-off' }
  }
  const store = listWslMoveDesktopRewriteStores().find((entry) => entry.id === request.storeId)
  if (!store) {
    return { recorded: false, reason: 'unknown-store' }
  }
  if (store.side !== 'renderer') {
    return { recorded: false, reason: 'not-renderer-store' }
  }
  try {
    const cutover = readCommittedCutover(userDataPath, request.migrationId)
    if (!cutover || cutover.rewrittenStores.includes(store.id)) {
      return { recorded: false, reason: 'not-pending' }
    }
    appendLedgerEntry(userDataPath, cutover, store.id)
  } catch (error) {
    console.warn(`[wsl-move] Could not record a renderer rewrite: ${describe(error)}`)
    return { recorded: false, reason: 'failed' }
  }
  try {
    advanceWhenRewritten(userDataPath, request.migrationId)
  } catch (error) {
    // The entry is durable; the next pass retries the advance.
    console.warn(`[wsl-move] Could not finish the desktop rewrite: ${describe(error)}`)
  }
  return { recorded: true }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
