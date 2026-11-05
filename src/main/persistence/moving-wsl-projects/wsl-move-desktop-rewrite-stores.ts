// Record each store only after durable rewrite so crashes retry the unfinished stores.
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import { WSL_MOVE_RENDERER_REWRITE_STORE_IDS } from '../../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import type { OrcadMigrationPathRewriter } from '../../ssh/orcad-migration-path-rewrite'

export type WslMoveDesktopRewriteContext = {
  cutover: Readonly<WslMoveCutover>
  rewritePath: OrcadMigrationPathRewriter
  destinationHostId: `runtime:${string}`
  /** Durable before it returns; `cutover.seededHostWorkspaceIds` holds what earlier runs recorded. */
  recordSeededHostWorkspaceIds: (workspaceIds: readonly string[]) => void
}

export type WslMoveMainRewriteStore = {
  id: string
  side: 'main'
  /** Must be idempotent: crashes before the ledger write rerun this step. */
  run: (context: WslMoveDesktopRewriteContext) => Promise<void> | void
  /** Resolve durably before the journal records this store. */
  flush: () => Promise<void> | void
}

export type WslMoveRendererRewriteStore = {
  id: string
  side: 'renderer'
}

export type WslMoveDesktopRewriteStore = WslMoveMainRewriteStore | WslMoveRendererRewriteStore

// Match the journal schema so every registered store fits its ledger.
const STORE_ID_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/
const MAX_STORES = 256

// Every desktop-rewrite disposition has its store (wsl-move-rewrite-store-coverage.test.ts proves it).
export const WSL_MOVE_DESKTOP_REWRITE_REGISTRY_COMPLETE: boolean = true

let registryComplete = WSL_MOVE_DESKTOP_REWRITE_REGISTRY_COMPLETE

export function isWslMoveDesktopRewriteRegistryComplete(): boolean {
  return registryComplete
}

export function setWslMoveDesktopRewriteRegistryCompleteForTests(complete: boolean): boolean {
  const previous = registryComplete
  registryComplete = complete
  return previous
}

const stores: WslMoveDesktopRewriteStore[] = []

/** Main stores run in registration order; renderer acknowledgements can arrive independently. */
export function registerWslMoveDesktopRewriteStore(store: WslMoveDesktopRewriteStore): void {
  if (!STORE_ID_PATTERN.test(store.id)) {
    throw new Error('wsl_move_rewrite_store_id_invalid')
  }
  if (stores.some((entry) => entry.id === store.id)) {
    throw new Error('wsl_move_rewrite_store_duplicate')
  }
  if (stores.length >= MAX_STORES) {
    throw new Error('wsl_move_rewrite_store_limit')
  }
  stores.push(store)
}

/** The renderer's localStorage stores; the renderer rewrites and records each. */
export function registerWslMoveRendererRewriteStores(): void {
  for (const id of WSL_MOVE_RENDERER_REWRITE_STORE_IDS) {
    registerWslMoveDesktopRewriteStore({ id, side: 'renderer' })
  }
}

export function listWslMoveDesktopRewriteStores(): readonly WslMoveDesktopRewriteStore[] {
  return stores
}

export function pendingWslMoveDesktopRewriteStores(
  ledger: readonly string[]
): WslMoveDesktopRewriteStore[] {
  const recorded = new Set(ledger)
  return stores.filter((entry) => !recorded.has(entry.id))
}

export function resetWslMoveDesktopRewriteStoresForTests(): void {
  stores.length = 0
  registryComplete = WSL_MOVE_DESKTOP_REWRITE_REGISTRY_COMPLETE
}
