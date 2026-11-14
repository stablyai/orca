import type { OrcaSessionId } from '../../../shared/orca-session-address'
import type { AgentIdentityDemand } from './agent-identity-demand'
import type { AgentProviderKey } from './agent-provider-key'

/** The saved records a cache answers for: kept while `source` is the same saved map. */
export type SavedKeyPopulation = { source: object; keys: () => AgentProviderKey[] }

/** Saved sleeping records' ids for one store authority, linking nothing. An answer lives while
 *  its key is in the saved records and the authority stands, whatever subset a caller asks
 *  about. An id is never relinked, and a miss becomes an id only when this host names the key,
 *  which `named` records, so neither is asked twice. New keys go in one question; a failed one
 *  leaves only its own keys unknown. */
export class SavedAgentKeyIds {
  private authority = -1
  private ids = new Map<string, OrcaSessionId | null>()
  private population: object | null = null
  /** Keys whose question is in flight, so a naming meanwhile is not lost to its older answer. */
  private readonly asking = new Map<string, number>()

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
      for (const keyString of asked) {
        this.asking.set(keyString, (this.asking.get(keyString) ?? 0) + 1)
      }
      const answer = await this.demand
        .lookup(`idsOfKeys\0${asked.join('\0')}`, (client, path) =>
          client.idsOfKeys(path, [...missing.values()])
        )
        .finally(() => {
          for (const keyString of asked) {
            const count = (this.asking.get(keyString) ?? 1) - 1
            if (count === 0) {
              this.asking.delete(keyString)
            } else {
              this.asking.set(keyString, count)
            }
          }
        })
      if (answer && this.authority === authority && authority === this.demand.generation) {
        asked.forEach((keyString, index) => {
          if (!this.ids.has(keyString)) {
            this.ids.set(keyString, answer[index] ?? null)
          }
        })
      }
    }
    return strings.map((keyString) =>
      this.authority === authority ? (this.ids.get(keyString) ?? null) : null
    )
  }

  /** This host named `keyString`: a saved key's miss, or one being asked, becomes its id. */
  named(keyString: string, id: OrcaSessionId): void {
    if (this.ids.has(keyString) || this.asking.has(keyString)) {
      this.ids.set(keyString, id)
    }
  }

  /** A new authority answers afresh; a changed saved map drops keys no record names now. */
  private sync(population: SavedKeyPopulation): void {
    const authority = this.demand.authority()
    if (authority !== this.authority) {
      this.authority = authority
      this.ids = new Map()
      this.population = null
    }
    if (population.source !== this.population) {
      this.population = population.source
      const current = new Set(population.keys().map(this.keyString))
      for (const keyString of this.ids.keys()) {
        if (!current.has(keyString)) {
          this.ids.delete(keyString)
        }
      }
    }
  }
}
