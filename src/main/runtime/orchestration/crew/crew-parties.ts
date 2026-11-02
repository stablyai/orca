import { canonicalOrcaSessionFromEdges } from '../canonical-orca-session-id'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId,
  type OrcaSessionId,
  parseOrcaSessionAddress
} from '../../../../shared/orca-session-address'
import { isPublicOrchestrationAddress } from '../../../../shared/orchestration-agent-reference'
import { createCanonicalSessionPaneResolver, clearedInto } from '../structured-session-lineage'
import type { CrewReadDependencies } from './crew-read-model'
import type { CrewIdentityRead } from './crew-party-snapshot'

export type Party = AgentMessageSender['party'] & { paneKey: string | null }

export function createCrewPartyRegistry(deps: CrewReadDependencies) {
  const recordList = structuredClone(deps.records?.listRecords() ?? [])
  const recordMap = new Map(recordList.map((record) => [record.sessionId, record]))
  const adjacent = new Map<string, Set<string>>()
  const incoming = new Map<string, number>()
  const clearedFrom = new Map<string, string>()
  for (const record of recordList) {
    const next = clearedInto(record)
    if (!next) {
      continue
    }
    clearedFrom.set(next, record.sessionId)
    incoming.set(next, (incoming.get(next) ?? 0) + 1)
    for (const [from, to] of [
      [record.sessionId, next],
      [next, record.sessionId]
    ]) {
      const neighbors = adjacent.get(from) ?? new Set<string>()
      neighbors.add(to)
      adjacent.set(from, neighbors)
    }
  }
  const roots = new Map<string, string>()
  const lineageAliases = new Map<string, string[]>()
  for (const record of recordList) {
    if (roots.has(record.sessionId)) {
      continue
    }
    const component = new Set<string>([record.sessionId])
    for (const id of component) {
      for (const peer of adjacent.get(id) ?? []) {
        component.add(peer)
      }
    }
    const heads = [...component].filter((id) => !incoming.has(id))
    const valid =
      heads.length === 1 &&
      [...component].every((id) => recordMap.has(id) && (incoming.get(id) ?? 0) <= 1)
    // Corrupt or incomplete chains retain their own identity; traversal order cannot merge them.
    for (const id of component) {
      roots.set(id, valid ? heads[0] : id)
    }
    if (valid) {
      lineageAliases.set(
        heads[0],
        [...component].sort().map((id) => {
          if (!isOrcaSessionId(id)) {
            throw new Error(`Not an Orca session id: ${id}`)
          }
          return formatOrcaSessionAddress(id)
        })
      )
    }
  }
  const root = (id: string) => roots.get(id) ?? id
  const records = deps.records
    ? {
        ...deps.records,
        listRecords: () => recordList,
        getRecord: (id: string) => recordMap.get(id) ?? null
      }
    : null
  const canonicalPane = createCanonicalSessionPaneResolver(records)
  const build = (base?: CrewPartyLookup, identity?: CrewIdentityRead) => {
    const parties = new Map<string, Party>()
    const aliases = new Map<string, string>()
    const aliasesByParty = new Map<string, Set<string>>()
    const alias = (address: string, identity: string) => {
      const previous = aliases.get(address) ?? base?.addressOf(address)
      if (previous === identity || base?.addressOf(address) || (previous && previous !== address)) {
        return
      }
      if (previous) {
        aliasesByParty.get(previous)?.delete(address)
      }
      aliases.set(address, identity)
      const members = aliasesByParty.get(identity) ?? new Set<string>()
      members.add(address)
      aliasesByParty.set(identity, members)
    }
    const party = (
      session: string | null,
      storedHandle: string | null,
      pane: string | null,
      fallback?: string,
      process?: string | null,
      read?: CrewIdentityRead
    ): Party | undefined => {
      const inputs = read ?? identity ?? deps.openIdentityRead?.() ?? deps
      const sessionId = session ? root(session) : null
      const liveHandle = pane ? inputs.handleForPane(pane) : null
      const candidateHandle =
        liveHandle ?? (storedHandle && inputs.liveHandle(storedHandle) ? storedHandle : null)
      const currentProcess = candidateHandle ? inputs.processForHandle?.(candidateHandle) : null
      const mismatch = Boolean(process && currentProcess && process !== currentProcess)
      const handle = mismatch ? null : candidateHandle
      const publicHandle = handle?.startsWith('term_') ? handle : null
      const publicAddress =
        sessionId && isOrcaSessionId(sessionId)
          ? formatOrcaSessionAddress(sessionId)
          : ((publicHandle && (aliases.get(publicHandle) ?? base?.addressOf(publicHandle))) ??
            publicHandle ??
            fallback)
      if (!publicAddress || !isPublicOrchestrationAddress(publicAddress)) {
        return undefined
      }
      const existing = parties.get(publicAddress) ?? base?.getParty(publicAddress)
      const value = existing ?? {
        address: publicAddress,
        terminalHandle: publicHandle,
        orcaSessionId: parseOrcaSessionAddress(publicAddress),
        paneKey: sessionId ? canonicalPane(sessionId) : pane
      }
      parties.set(publicAddress, value)
      const registerAlias = alias
      for (const alias of [
        publicAddress,
        ...(sessionId ? (lineageAliases.get(sessionId) ?? []) : []),
        mismatch ? null : storedHandle,
        handle,
        session && isOrcaSessionId(session) ? formatOrcaSessionAddress(session) : null
      ]) {
        if (alias) {
          registerAlias(alias, publicAddress)
        }
      }
      return value
    }
    const lookup: CrewPartyLookup = {
      addressOf: (address) => aliases.get(address) ?? base?.addressOf(address),
      getParty: (address) => parties.get(address) ?? base?.getParty(address),
      aliasesFor: (address) => [
        ...new Set([...(base?.aliasesFor(address) ?? []), ...(aliasesByParty.get(address) ?? [])])
      ]
    }
    return {
      ...lookup,
      parties,
      aliases,
      aliasesByParty,
      alias,
      party,
      records,
      commandCanonical: (id: OrcaSessionId) => canonicalOrcaSessionFromEdges(id, clearedFrom),
      fork: (identity?: CrewIdentityRead) => build(lookup, identity)
    }
  }
  return build()
}

export type CrewPartyLookup = {
  addressOf: (address: string) => string | undefined
  getParty: (address: string) => Party | undefined
  aliasesFor: (address: string) => string[]
}
