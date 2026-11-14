import type { OrcaSessionId } from '../../../shared/orca-session-address'
import type { AgentIdentityDemand } from './agent-identity-demand'
import type { AgentProviderKey } from './agent-provider-key'

/** The saved records a memo answers for, by the saved map's identity; held weakly. */
export type SavedKeyPopulation = { source: object; keys: () => AgentProviderKey[] }

/** Saved sleeping records' ids for one store authority, linking nothing. Members are the keys
 *  the current saved map names, whatever subset a caller asks about; an answer lives while its
 *  key is a member and the authority stands. An id is never relinked, and a miss becomes an id
 *  only when this host commits the key's link, which `linked` records even when no live pane
 *  waits for it. New keys go in one question; a failed one leaves only its own keys unknown. */
export class SavedAgentKeyIds {
  private authority = -1
  private population: WeakRef<object> | null = null
  private members = new Set<string>()
  private ids = new Map<string, OrcaSessionId | null>()

  constructor(
    private readonly demand: AgentIdentityDemand,
    private readonly keyString: (key: AgentProviderKey) => string
  ) {}

  /** Each key's id, in order; null for none, or while the store cannot answer for it. */
  async idsOf(
    keys: readonly AgentProviderKey[],
    population: SavedKeyPopulation
  ): Promise<(OrcaSessionId | null)[]> {
    this.sync(population)
    const authority = this.authority
    const strings = keys.map(this.keyString)
    const missing = new Map<string, AgentProviderKey>()
    keys.forEach((key, index) => {
      if (!this.ids.has(strings[index]!)) {
        missing.set(strings[index]!, key)
      }
    })
    if (missing.size > 0) {
      const asked = [...missing.keys()]
      const answer = await this.demand.lookup(`idsOfKeys\0${asked.join('\0')}`, (client, path) =>
        client.idsOfKeys(path, [...missing.values()])
      )
      if (answer && this.current(authority)) {
        asked.forEach((keyString, index) => {
          // A key no longer saved, or linked meanwhile, keeps out an older answer.
          if (this.members.has(keyString) && !this.ids.has(keyString)) {
            this.ids.set(keyString, answer[index] ?? null)
          }
        })
      }
    }
    // The whole batch answers for one authority, cached members included.
    return strings.map((keyString) =>
      this.current(authority) ? (this.ids.get(keyString) ?? null) : null
    )
  }

  /** Brings membership to the current saved map; O(1) while it is the same map. */
  sync(population: SavedKeyPopulation): void {
    const authority = this.demand.authority()
    if (authority !== this.authority) {
      this.clear()
      this.authority = authority
    }
    if (this.population?.deref() === population.source) {
      return
    }
    this.population = new WeakRef(population.source)
    this.members = new Set(population.keys().map(this.keyString))
    for (const keyString of this.ids.keys()) {
      if (!this.members.has(keyString)) {
        this.ids.delete(keyString)
      }
    }
  }

  /** This store committed `keyString`'s link: a saved key's miss becomes its id. */
  linked(keyString: string, id: OrcaSessionId, authority: number): void {
    if (authority === this.authority && this.members.has(keyString)) {
      this.ids.set(keyString, id)
    }
  }

  /** The authority ended or its owner closed: nothing it answered is kept. */
  clear(): void {
    this.authority = -1
    this.population = null
    this.members = new Set()
    this.ids = new Map()
  }

  private current(authority: number): boolean {
    return this.authority === authority && authority === this.demand.generation
  }
}
