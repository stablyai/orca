import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import { notifyRuntimeListeners } from '../../events/runtime-listener-delivery'
import { windowOwns } from '../../session-tabs/person/person-workspace-target'

type RuntimeClientEventBusDeps = {
  makeTitleGateKey: (rawTitle: string, normalizedTitle: string) => string
  onConsumerAvailabilityChanged: () => void
  /** The tab list an event is about, classified once as it is emitted: undefined for an event about
   *  none, null when its list is unknown (a PTY with no record), which only `every` hears. */
  tabListOf: (event: RuntimeClientEvent) => string | null | undefined
}

/** Which tab lists' events a listener hears: the host lists' (the owner's window, sidebar,
 *  notifications and devices; the default), every list's, or the lists a predicate names. */
export type ClientEventTabLists = 'host' | 'every' | ((list: string) => boolean)

export class RuntimeClientEventBus {
  private readonly listeners = new Set<(event: RuntimeClientEvent) => void>()
  private readonly excludedTerminalSideEffectListeners = new Set<
    (event: RuntimeClientEvent) => void
  >()
  private readonly tabListsByListener = new Map<
    (event: RuntimeClientEvent) => void,
    ClientEventTabLists
  >()
  private readonly titleGateKeysByListener = new Map<
    (event: RuntimeClientEvent) => void,
    Map<string, string>
  >()

  constructor(private readonly deps: RuntimeClientEventBusDeps) {}

  on(
    listener: (event: RuntimeClientEvent) => void,
    options?: { consumesTerminalSideEffects?: boolean; tabLists?: ClientEventTabLists }
  ): () => void {
    this.listeners.add(listener)
    this.tabListsByListener.set(listener, options?.tabLists ?? 'host')
    if (options?.consumesTerminalSideEffects === false) {
      this.excludedTerminalSideEffectListeners.add(listener)
    } else {
      this.titleGateKeysByListener.set(listener, new Map())
    }
    this.deps.onConsumerAvailabilityChanged()
    return () => {
      this.listeners.delete(listener)
      this.tabListsByListener.delete(listener)
      this.excludedTerminalSideEffectListeners.delete(listener)
      this.titleGateKeysByListener.delete(listener)
      this.deps.onConsumerAvailabilityChanged()
    }
  }

  countTerminalSideEffectConsumers(): number {
    return this.listeners.size - this.excludedTerminalSideEffectListeners.size
  }

  /** Whether a listener taking `lists` hears an event, as `emit` delivers it; for a replay of
   *  earlier events to one listener. */
  hears(event: RuntimeClientEvent, lists: ClientEventTabLists = 'host'): boolean {
    const list = this.deps.tabListOf(event)
    return list === undefined || hearsTabList(lists, list)
  }

  emit(event: RuntimeClientEvent): void {
    const list = this.deps.tabListOf(event)
    notifyRuntimeListeners(
      this.listeners,
      (listener) => {
        if (list !== undefined && !hearsTabList(this.tabListsByListener.get(listener), list)) {
          return
        }
        if (event.type !== 'terminalSideEffects') {
          listener(event)
          return
        }
        const filtered = this.filterTerminalSideEffects(listener, event)
        if (filtered) {
          listener(filtered)
        }
      },
      'client-event'
    )
  }

  clearPtyTitleGate(ptyId: string): void {
    for (const titleGateKeys of this.titleGateKeysByListener.values()) {
      titleGateKeys.delete(ptyId)
    }
  }

  private filterTerminalSideEffects(
    listener: (event: RuntimeClientEvent) => void,
    event: Extract<RuntimeClientEvent, { type: 'terminalSideEffects' }>
  ): Extract<RuntimeClientEvent, { type: 'terminalSideEffects' }> | null {
    const titleGateKeys = this.titleGateKeysByListener.get(listener)
    if (!titleGateKeys) {
      return null
    }
    const facts = event.batch.facts.filter((fact) => {
      if (fact.kind !== 'title') {
        return true
      }
      const gateKey = this.deps.makeTitleGateKey(fact.rawTitle, fact.normalizedTitle)
      if (titleGateKeys.get(event.batch.ptyId) === gateKey) {
        return false
      }
      titleGateKeys.set(event.batch.ptyId, gateKey)
      return true
    })
    if (facts.length === 0) {
      return null
    }
    return facts.length === event.batch.facts.length
      ? event
      : { ...event, batch: { ...event.batch, facts } }
  }
}

function hearsTabList(lists: ClientEventTabLists | undefined, list: string | null): boolean {
  if (lists === 'every') {
    return true
  }
  if (list === null) {
    return false
  }
  return lists === undefined || lists === 'host' ? windowOwns(list) : lists(list)
}
