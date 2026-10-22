/**
 * The desktop stores a committed WSL move rewrites before it reaches `client-rewritten`
 * (design, section 4.4). Each id is recorded in the journal's `rewrittenStores` ledger once its
 * store is rewritten and durable, so a crash redoes only the rest.
 */
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import type { OrcadMigrationPathRewriter } from '../../ssh/orcad-migration-path-rewrite'

export type WslMoveDesktopRewriteContext = {
  cutover: Readonly<WslMoveCutover>
  /** UNC paths of the moved distro become the Linux paths the host sees. */
  rewritePath: OrcadMigrationPathRewriter
  /** The execution host the moved projects now belong to. */
  destinationHostId: `runtime:${string}`
}

export type WslMoveMainRewriteStore = {
  id: string
  side: 'main'
  /** Must be idempotent: a crash before its ledger entry runs it again. */
  run: (context: WslMoveDesktopRewriteContext) => Promise<void> | void
  /** Makes what `run` wrote durable; its ledger entry is written only after this resolves. */
  flush: () => Promise<void> | void
}

/** Rewritten by the renderer, which records it over IPC. */
export type WslMoveRendererRewriteStore = {
  id: string
  side: 'renderer'
}

export type WslMoveDesktopRewriteStore = WslMoveMainRewriteStore | WslMoveRendererRewriteStore

// Within the journal schema's ledger bounds, so a registered id always fits the ledger.
const STORE_ID_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/
const MAX_STORES = 256

// 7f (the last store PR) flips this; until then no move may leave `destination-committed`.
export const WSL_MOVE_DESKTOP_REWRITE_REGISTRY_COMPLETE: boolean = false

let registryComplete = WSL_MOVE_DESKTOP_REWRITE_REGISTRY_COMPLETE

/** The journal and the driver both refuse `client-rewritten` while this is false. */
export function isWslMoveDesktopRewriteRegistryComplete(): boolean {
  return registryComplete
}

/** Returns the previous value, so a fixture can restore it. */
export function setWslMoveDesktopRewriteRegistryCompleteForTests(complete: boolean): boolean {
  const previous = registryComplete
  registryComplete = complete
  return previous
}

const stores: WslMoveDesktopRewriteStore[] = []

/**
 * Registration order is run order among main-side stores. Renderer-side stores are independent of
 * it: the renderer records them whenever it finishes, before or after any main store.
 */
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

export function listWslMoveDesktopRewriteStores(): readonly WslMoveDesktopRewriteStore[] {
  return stores
}

/** Registered stores the ledger does not record yet, in run order. */
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
