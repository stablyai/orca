import type { IPtyProvider, PtyProcessInfo } from './pty-provider-contract'
import { RuntimePtyOwnershipTransferProviderObserver } from './runtime-pty-ownership-transfer-provider-observer'
import type { RuntimePtyOwnershipTransferSourceAdapter } from './runtime-pty-ownership-transfer-source-adapter'
import type { RuntimePtySourceAuthorityRegistry } from './runtime-pty-source-authority-registry'

type ObservedProvider = Pick<IPtyProvider, 'listProcesses' | 'onData' | 'onExit'>
type SourceAdapter = Pick<
  RuntimePtyOwnershipTransferSourceAdapter,
  'beginProviderReplacement' | 'observeOutput' | 'observeExit' | 'restoreInputFences'
>

export type RuntimePtyProviderReconciliation = Readonly<{
  generation: number
  state: 'current' | 'superseded' | 'unverifiable'
  authorities: number
}>

type ProviderLifecycleOptions = Readonly<{
  onError?: (error: unknown) => void
}>

type LatestEvent = Readonly<{ incarnationId: string; live: boolean }>

/** Keeps host-local source authority aligned with the exact installed provider generation. */
export class RuntimePtyOwnershipTransferProviderLifecycle {
  private observer: RuntimePtyOwnershipTransferProviderObserver | null = null
  private generation = 0

  constructor(
    private readonly registry: RuntimePtySourceAuthorityRegistry,
    private readonly adapter: SourceAdapter,
    private readonly options: ProviderLifecycleOptions = {}
  ) {}

  async replaceProvider(provider: ObservedProvider): Promise<RuntimePtyProviderReconciliation> {
    const generation = ++this.generation
    const latestEvents = new Map<string, LatestEvent>()
    const eventIncarnations = new Map<string, string>()
    const conflictingTerminals = new Set<string>()
    this.registry.deactivateAll()
    this.adapter.beginProviderReplacement()

    const nextObserver = new RuntimePtyOwnershipTransferProviderObserver(provider, {
      observeOutput: (event) => {
        if (this.generation !== generation) {
          return undefined
        }
        const previousIncarnation = eventIncarnations.get(event.terminalId)
        if (previousIncarnation && previousIncarnation !== event.incarnationId) {
          // A PTY id changing incarnation in one provider generation is ambiguous: a
          // delayed old event must not rotate durable authority back to the stale process.
          conflictingTerminals.add(event.terminalId)
          return undefined
        }
        eventIncarnations.set(event.terminalId, event.incarnationId)
        latestEvents.set(event.terminalId, { incarnationId: event.incarnationId, live: true })
        try {
          this.registry.admit(event.terminalId, event.incarnationId)
          return this.adapter.observeOutput(event)
        } catch (error) {
          this.options.onError?.(error)
          return undefined
        }
      },
      observeExit: (event) => {
        if (this.generation !== generation) {
          return
        }
        const previousIncarnation = eventIncarnations.get(event.terminalId)
        if (previousIncarnation && previousIncarnation !== event.incarnationId) {
          // Ignore an exit for a superseded incarnation; it cannot retire current authority.
          return
        }
        eventIncarnations.set(event.terminalId, event.incarnationId)
        latestEvents.set(event.terminalId, { incarnationId: event.incarnationId, live: false })
        try {
          this.adapter.observeExit(event)
        } catch (error) {
          this.options.onError?.(error)
        } finally {
          try {
            this.registry.retire(event.terminalId, event.incarnationId)
          } catch (error) {
            this.options.onError?.(error)
          }
        }
      }
    })
    const previousObserver = this.observer
    this.observer = nextObserver
    previousObserver?.dispose()

    let inventory: PtyProcessInfo[]
    try {
      inventory = await provider.listProcesses()
    } catch (error) {
      if (this.generation !== generation) {
        return { generation, state: 'superseded', authorities: 0 }
      }
      // A failed inventory cannot prove any event-derived authority is live.
      this.registry.deactivateAll()
      this.options.onError?.(error)
      return { generation, state: 'unverifiable', authorities: 0 }
    }
    if (this.generation !== generation) {
      return { generation, state: 'superseded', authorities: 0 }
    }

    try {
      if (conflictingTerminals.size > 0) {
        throw new Error('runtime_pty_source_authority_incarnation_ambiguous')
      }
      const reconciledInventory = mergeInventoryWithEvents(inventory, latestEvents)
      const authorities = this.registry.reconcile(reconciledInventory)
      this.adapter.restoreInputFences()
      return { generation, state: 'current', authorities: authorities.length }
    } catch (error) {
      this.registry.deactivateAll()
      this.options.onError?.(error)
      return { generation, state: 'unverifiable', authorities: 0 }
    }
  }

  dispose(): void {
    this.generation++
    this.observer?.dispose()
    this.observer = null
    this.registry.deactivateAll()
    this.adapter.beginProviderReplacement()
  }
}

function mergeInventoryWithEvents(
  inventory: readonly PtyProcessInfo[],
  events: ReadonlyMap<string, LatestEvent>
): PtyProcessInfo[] {
  const merged = new Map<string, PtyProcessInfo>()
  const duplicateIds = new Set<string>()
  for (const process of inventory) {
    if (merged.has(process.id)) {
      duplicateIds.add(process.id)
    }
    merged.set(process.id, process)
  }
  if (duplicateIds.size > 0) {
    throw new Error('runtime_pty_source_authority_inventory_ambiguous')
  }
  for (const [terminalId, event] of events) {
    const inventoried = merged.get(terminalId)
    if (event.live) {
      merged.set(terminalId, {
        ...(inventoried ?? emptyProcess(terminalId)),
        incarnationId: event.incarnationId
      })
    } else if (inventoried?.incarnationId === event.incarnationId) {
      merged.delete(terminalId)
    }
  }
  return [...merged.values()]
}

function emptyProcess(id: string): PtyProcessInfo {
  return { id, cwd: '', title: '' }
}
