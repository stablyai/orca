import { z } from 'zod'
import type { OrchestrationDb } from '../db/orchestration-db'
import {
  readCrewParentInputs,
  type CrewParentClaim,
  type CrewParentResource
} from './crew-parent-inputs'
import {
  readCrewRuns,
  readCrewOwnedRunAddresses,
  readCrewTraffic,
  readCrewQuestions,
  readCrewApprovals,
  type CrewAssignmentRow
} from './crew-query'
import type { OrchestrationCoordinatorKey } from '../addressing/orchestration-caller-identity'
import { exposeUtcTimestamp } from '../db/utc-timestamp'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { paneKeyMatchSuffix } from '../db/pane-key-match'

type ProvenanceRow = Pick<CrewParentClaim, 'id' | 'handle' | 'pane' | 'session' | 'process'>
type Provenance = { local: ProvenanceRow[]; remote: ProvenanceRow[] }
type Run = ReturnType<typeof readCrewRuns>[number]

/** Disposable host input indexes contain source facts, never projected parties or selected parents. */
export function createCrewSourceInputs(db: OrchestrationDb | null, capacity = () => 256) {
  const sourceFingerprint =
    z
      .object({ caller_fingerprint: z.string() })
      .optional()
      .parse(
        db?.db
          .prepare(
            "SELECT caller_fingerprint FROM mutation_caller_identities WHERE transport = 'local_authenticated_transport'"
          )
          .get()
      )?.caller_fingerprint ?? null
  let legacy: ReturnType<OrchestrationDb['getLegacyAdoptedRunMailboxOwner']> | undefined
  const legacyOwner = () =>
    legacy === undefined ? (legacy = db?.getLegacyAdoptedRunMailboxOwner() ?? null) : legacy
  const claims = new Map<string, CrewParentClaim>()
  const claimsByKey = new Map<string, Set<string>>()
  const creators = new Map<string, CrewParentClaim>()
  const creatorAssignments = new Map<string, CrewAssignmentRow>()
  const resources = new Map<string, CrewParentResource>()
  const resourcesByKey = new Map<string, Set<string>>()
  const covered = new Set<string>()
  const runs = new Map<string, Run>()
  const knownRuns = new Set<string>()
  const index = (map: Map<string, Set<string>>, key: string | null, id: string) => {
    if (!key) {
      return
    }
    const ids = map.get(key) ?? new Set<string>()
    ids.add(id)
    map.set(key, ids)
  }
  const parentInputs = (addresses: string[], panes: string[] = []) => {
    const paneKey = (pane: string) =>
      parsePaneKey(pane) ? `leaf:${paneKeyMatchSuffix(pane)}` : `pane:${pane}`
    const keys = [...addresses, ...panes.map(paneKey)]
    const missing = keys.filter((key) => !covered.has(key))
    if (db && missing.length) {
      const input = readCrewParentInputs(
        db,
        addresses.filter((key) => !covered.has(key)),
        panes.filter((pane) => !covered.has(paneKey(pane)))
      )
      for (const row of input.claims) {
        const id = JSON.stringify([row.family, row.home, row.id])
        claims.set(id, Object.freeze(row))
        for (const key of [
          row.handle,
          row.pane ? paneKey(row.pane) : null,
          row.session ? `orca_session_id:${row.session}` : null,
          `dispatch:${row.id}`
        ]) {
          index(claimsByKey, key, id)
        }
      }
      for (const row of input.creators) {
        creators.set(row.id, Object.freeze(row))
      }
      for (const row of input.creatorAssignments) {
        creatorAssignments.set(row.id, Object.freeze(row))
      }
      for (const row of input.resources) {
        resources.set(row.id, Object.freeze(row))
        for (const key of [
          row.handle,
          row.pane ? paneKey(row.pane) : null,
          `dispatch:${row.owner}`
        ]) {
          index(resourcesByKey, key, row.id)
        }
      }
      for (const key of missing) {
        covered.add(key)
      }
    }
    const ids = new Set(keys.flatMap((key) => [...(claimsByKey.get(key) ?? [])]))
    const selected = [...ids].map((id) => claims.get(id)!)
    const resourceIds = new Set(
      [...keys, ...selected.map((row) => `dispatch:${row.id}`)].flatMap((key) => [
        ...(resourcesByKey.get(key) ?? [])
      ])
    )
    return {
      claims: selected,
      sourceFingerprint,
      creatorAssignments: selected.flatMap((row) =>
        row.creator && creatorAssignments.has(row.creator)
          ? [creatorAssignments.get(row.creator)!]
          : []
      ),
      creators: selected.flatMap((row) =>
        row.creator && creators.has(row.creator) ? [creators.get(row.creator)!] : []
      ),
      resources: [...resourceIds].map((id) => resources.get(id)!)
    }
  }
  const provenance = (addresses: string[], panes: string[] = []): Provenance => {
    const input = parentInputs(addresses, panes)
    const rows = (family: CrewParentClaim['family']) =>
      input.claims
        .filter((row) => row.family === family)
        .map((row) => ({
          id: row.id,
          handle: row.handle,
          pane: row.pane,
          session: row.session,
          process: row.process
        }))
    return { local: rows('local'), remote: rows('remote') }
  }
  const activeRemoteAttachmentForPane = (pane: string) => {
    const candidates = parentInputs([], [pane]).claims
    let selected: CrewParentClaim | undefined
    for (const row of candidates) {
      if (
        row.remoteRoute?.active &&
        row.pane &&
        (parsePaneKey(pane)
          ? row.pane.indexOf(':') > 0 && paneKeyMatchSuffix(row.pane) === paneKeyMatchSuffix(pane)
          : row.pane === pane) &&
        (!selected || row.remoteRoute.ordinal > selected.remoteRoute!.ordinal)
      ) {
        selected = row
      }
    }
    return selected
  }
  const runInputs = (addresses: string[]) => {
    const missing = addresses.filter(
      (address) => address.startsWith('run:') && !knownRuns.has(address)
    )
    if (db && missing.length) {
      for (const row of readCrewRuns(db, missing)) {
        runs.set(`run:${row.id}`, Object.freeze(row))
      }
      for (const address of missing) {
        knownRuns.add(address)
      }
    }
    return addresses.flatMap((address) => (runs.has(address) ? [runs.get(address)!] : []))
  }
  const owned = new Map<string, string[]>()
  const mail = new Map<
    string,
    {
      aliases: readonly string[]
      traffic?: {
        rows: ReturnType<typeof readCrewTraffic>
        queriedAt: number
        validThrough: number
      }
      questions?: ReturnType<typeof readCrewQuestions>
      approvals?: ReturnType<typeof readCrewApprovals>
    }
  >()
  const retain = <T>(cache: Map<string, T>, key: string, value: T): T => {
    cache.set(key, value)
    while (cache.size > capacity()) {
      cache.delete(cache.keys().next().value!)
    }
    return value
  }
  const ownedRuns = (party: OrchestrationCoordinatorKey) => {
    const key = JSON.stringify([party.terminalHandle, party.orcaSessionId, party.paneKey])
    return (
      owned.get(key) ??
      retain(owned, key, db ? readCrewOwnedRunAddresses(db, party, legacyOwner) : [])
    )
  }
  const mailbox = (aliases: string[]): NonNullable<ReturnType<typeof mail.get>> => {
    const selected = [...new Set(aliases)].sort()
    const key = JSON.stringify(selected)
    return mail.get(key) ?? retain(mail, key, { aliases: selected })
  }
  const traffic = (aliases: string[], now: number) => {
    const input = mailbox(aliases)
    const cached = input.traffic
    if (cached && now >= cached.queriedAt && now <= cached.validThrough) {
      return cached.rows
    }
    const rows = db
      ? readCrewTraffic(db, aliases, new Date(now - AGENT_STATUS_STALE_AFTER_MS).toISOString())
      : []
    let validThrough = Infinity
    for (const row of rows) {
      const at = Date.parse(exposeUtcTimestamp(row.created_at)!)
      validThrough = Math.min(
        validThrough,
        Number.isFinite(at) ? at + AGENT_STATUS_STALE_AFTER_MS : -Infinity
      )
    }
    input.traffic = { rows, queriedAt: now, validThrough }
    return rows
  }
  const questions = (aliases: string[]) => {
    const input = mailbox(aliases)
    return (input.questions ??= db ? readCrewQuestions(db, aliases) : [])
  }
  // Closed approvals stay as receipts for as long as traffic counts as recent.
  const approvals = (aliases: string[], now: number) => {
    const input = mailbox(aliases)
    return (input.approvals ??= db
      ? readCrewApprovals(db, aliases, new Date(now - AGENT_STATUS_STALE_AFTER_MS).toISOString())
      : [])
  }
  const invalidateTraffic = (addresses?: ReadonlySet<string>) => {
    for (const [key, input] of mail) {
      if (!addresses || input.aliases.some((address) => addresses.has(address))) {
        mail.delete(key)
      }
    }
  }
  return {
    parentInputs,
    provenance,
    runInputs,
    activeRemoteAttachmentForPane,
    legacyOwner,
    ownedRuns,
    traffic,
    questions,
    approvals,
    invalidateTraffic
  }
}
