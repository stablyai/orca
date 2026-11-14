import type { OrcaSessionId } from '../../../shared/orca-session-address'
import type { AgentIdentityDemand } from './agent-identity-demand'
import type { AgentProviderKey } from './agent-provider-key'

/** Saved keys' ids for one store authority at a time, linking nothing. An id is never relinked,
 *  so each key is asked once per authority, every new key in one question; only the keys last
 *  asked are kept. */
export class SavedAgentKeyIds {
  private authority = -1
  private ids = new Map<string, OrcaSessionId | null>()

  constructor(
    private readonly demand: AgentIdentityDemand,
    private readonly keyString: (key: AgentProviderKey) => string
  ) {}

  /** Each key's id, in order, null for none; undefined when the store cannot answer now. */
  async idsOf(keys: readonly AgentProviderKey[]): Promise<(OrcaSessionId | null)[] | undefined> {
    const authority = this.demand.authority()
    if (this.authority !== authority) {
      this.authority = authority
      this.ids = new Map()
    }
    const known = this.ids
    const strings = keys.map(this.keyString)
    const missing = keys.filter((_, index) => !known.has(strings[index]!))
    if (missing.length > 0) {
      const missingStrings = missing.map(this.keyString)
      const answer = await this.demand.lookup(
        `idsOfKeys\0${missingStrings.join('\0')}`,
        (client, path) => client.idsOfKeys(path, missing)
      )
      if (!answer || authority !== this.demand.generation) {
        return undefined
      }
      missingStrings.forEach((keyString, index) => known.set(keyString, answer[index] ?? null))
    }
    // A key named since it was asked is the demand's.
    const ids = strings.map(
      (keyString) => known.get(keyString) ?? this.demand.of(keyString)?.identity.id ?? null
    )
    if (known.size > strings.length && this.ids === known) {
      this.ids = new Map(strings.map((keyString, index) => [keyString, ids[index]!]))
    }
    return ids
  }
}
