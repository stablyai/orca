// Persist each store before its ledger entry; restart retries only unrecorded rewrites.
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

// One hung store would stall every serialized pass.
export const WSL_MOVE_REWRITE_STORE_TIMEOUT_MS = 30_000

export type WslMoveDesktopRewritePassOptions = {
  userDataPath: string
  /** Applied separately to run and flush; defaults to WSL_MOVE_REWRITE_STORE_TIMEOUT_MS. */
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

/** Read the current ledger so concurrent acknowledgements cannot be overwritten. */
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

function advanceWhenRewritten(userDataPath: string, migrationId: string): void {
  // Advancing early would permanently skip stores not yet registered.
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

/** Ignore late results after timeout; never record them. */
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
      // Missing ledger entries make failed stores retry next pass.
      warn(`[wsl-move] Desktop rewrite of move ${migrationId} paused: ${describe(error)}`)
    }
  }
}

let passQueue: Promise<void> = Promise.resolve()

/** Serialize passes to prevent concurrent rewrites; failures are logged rather than thrown. */
export function runWslMoveDesktopRewritePass(
  options: WslMoveDesktopRewritePassOptions
): Promise<void> {
  const next = passQueue.then(() => runPass(options))
  passQueue = next
  return next
}

export function runGatedWslMoveDesktopRewritePass(
  options: WslMoveDesktopRewritePassOptions
): Promise<void> {
  return wslHostsGateOpen() ? runWslMoveDesktopRewritePass(options) : Promise.resolve()
}

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

/** Record a durable renderer rewrite independently of main-store order. */
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
