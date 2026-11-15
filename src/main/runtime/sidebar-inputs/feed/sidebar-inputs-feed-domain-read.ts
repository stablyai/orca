import type { SidebarInputsFeedDomain } from './sidebar-inputs-feed'
import {
  SIDEBAR_INPUTS_SCHEMA_VERSION,
  SIDEBAR_INPUTS_SEMANTICS_VERSION,
  type SidebarInputsReadResult
} from '../../../../shared/sidebar-list/feed/sidebar-inputs-feed-contract'

export function feedReply(
  generation: string,
  kind: SidebarInputsReadResult['kind'],
  revision: number,
  from: number | null,
  domains: SidebarInputsReadResult['domains'],
  next: string | null
): SidebarInputsReadResult {
  return {
    generation,
    revision,
    schemaVersion: SIDEBAR_INPUTS_SCHEMA_VERSION,
    semanticsVersion: SIDEBAR_INPUTS_SEMANTICS_VERSION,
    kind,
    from,
    domains,
    next
  }
}

/** Each entity's JSON; null when the read failed or the producer has no snapshot yet. */
export function readDomain(domain: SidebarInputsFeedDomain): Map<string, string> | null {
  try {
    const snapshot = domain.read()
    if (!snapshot) {
      return null
    }
    const entities = new Map<string, string>()
    for (const [key, value] of Object.entries(snapshot)) {
      // What JSON cannot hold (undefined, a function) is absent, as it would be on the wire.
      const json: string | undefined = JSON.stringify(value)
      if (json !== undefined) {
        entities.set(key, json)
      }
    }
    return entities
  } catch (error) {
    // The domain keeps what it last published; the next flush or phone read tries again.
    console.warn(`[sidebar-inputs-feed] could not read ${domain.name}`, error)
    return null
  }
}
