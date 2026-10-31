import { z } from 'zod'
import type { CrewAssignmentRow } from './crew-query'
import { maximalCrewClaims } from './crew-claim-reduction'
import { isEquivalentPaneKey } from '../db/pane-key-match'
import type { CrewParentClaim, CrewParentInputs } from './crew-parent-inputs'
import type { createCrewPartyRegistry, Party } from './crew-parties'
import type { CrewReadDependencies } from './crew-read-model'

type Registry = ReturnType<typeof createCrewPartyRegistry>
export type CrewParentRelation = {
  parent: Party
  address: string
  key: string
  assignment?: CrewAssignmentRow
}
const claimKey = (row: CrewParentClaim) => JSON.stringify([row.family, row.home, row.id])

function sameWorker(a: CrewParentClaim, b: CrewParentClaim, registry: Registry): boolean {
  if (a.session && b.session) {
    const identity = registry.addressOf(`orca_session_id:${a.session}`)
    return Boolean(identity && identity === registry.addressOf(`orca_session_id:${b.session}`))
  }
  return Boolean(
    a.process &&
    a.process === b.process &&
    (a.host === b.host ||
      ((a.family === 'remote' || b.family === 'remote') &&
        a.endpoint &&
        a.endpoint === b.endpoint)) &&
    a.pane &&
    b.pane &&
    isEquivalentPaneKey(a.pane, b.pane)
  )
}

/** Only retained causal edges order claims; birth, status and metadata clocks cannot do so. */
export function crewParentRelations(
  inputs: CrewParentInputs,
  self: Party,
  registry: Registry,
  deps: CrewReadDependencies
): CrewParentRelation[] {
  const bound = (row: CrewParentClaim) => {
    if (!row.session && !row.handle && !row.pane) {
      return false
    }
    const currentProcess = self.terminalHandle ? deps.processForHandle?.(self.terminalHandle) : null
    if (currentProcess && row.process && currentProcess !== row.process) {
      return false
    }
    if (row.session) {
      return registry.addressOf(`orca_session_id:${row.session}`) === self.address
    }
    return Boolean(
      (row.handle && registry.addressOf(row.handle) === self.address) ||
      (row.pane && self.paneKey && isEquivalentPaneKey(row.pane, self.paneKey))
    )
  }
  const boundClaims = inputs.claims.filter(bound)
  const localRepresentations = new Map(
    boundClaims.filter((row) => row.family === 'local').map((row) => [row.id, row])
  )
  const claims = boundClaims.filter((row) => {
    const local = localRepresentations.get(row.id)
    return !(
      row.family === 'remote' &&
      local &&
      inputs.sourceFingerprint &&
      row.home === inputs.sourceFingerprint &&
      local.runHome !== 'remote' &&
      local.run === row.run &&
      local.task === row.task &&
      sameWorker(local, row, registry) &&
      (!local.endpoint || !row.endpoint || local.endpoint === row.endpoint)
    )
  })
  const byId = new Map<string, CrewParentClaim[]>()
  for (const row of claims) {
    const group = byId.get(row.id) ?? []
    group.push(row)
    byId.set(row.id, group)
  }
  const successors = new Map<string, Set<string>>()
  const edge = (a: CrewParentClaim, b: CrewParentClaim) => {
    if (claimKey(a) === claimKey(b) || !sameWorker(a, b, registry)) {
      return
    }
    const next = successors.get(claimKey(a)) ?? new Set<string>()
    next.add(claimKey(b))
    successors.set(claimKey(a), next)
  }
  for (const row of claims) {
    if (row.family === 'local' && row.retry) {
      for (const prior of byId.get(row.retry) ?? []) {
        if (prior.family === 'local' && prior.task === row.task && prior.run === row.run) {
          edge(prior, row)
        }
      }
    }
  }
  for (const resource of inputs.resources) {
    const prior = z.array(z.string()).safeParse(
      (() => {
        try {
          return JSON.parse(resource.prior)
        } catch {
          return null
        }
      })()
    )
    if (
      !prior.success ||
      resource.ownership === 'external' ||
      !resource.process ||
      !resource.pane ||
      resource.endpointProcess !== resource.process ||
      prior.data[0] !== resource.origin ||
      new Set([...prior.data, resource.owner]).size !== prior.data.length + 1
    ) {
      continue
    }
    const chain = [...prior.data, resource.owner].map((id) => byId.get(id) ?? [])
    if (chain.some((group) => group.length !== 1)) {
      continue
    }
    const rows = chain.flat()
    const owner = rows.at(-1)!
    if (
      owner.endpoint !== resource.endpoint ||
      rows.some(
        (row) =>
          row.process !== resource.process ||
          (row.host !== resource.host &&
            !(row.family === 'remote' && row.endpoint && row.endpoint === resource.endpoint)) ||
          !row.pane ||
          !isEquivalentPaneKey(row.pane, resource.pane!)
      )
    ) {
      continue
    }
    for (let i = 1; i < rows.length; i++) {
      edge(rows[i - 1], rows[i])
    }
  }
  const maximalKeys = maximalCrewClaims(claims.map(claimKey), successors)
  const maximal = claims.filter((row) => maximalKeys.has(claimKey(row)))
  const creators = new Map(inputs.creators.map((row) => [row.id, row]))
  const creatorAssignments = new Map(inputs.creatorAssignments.map((row) => [row.id, row]))
  const managers = new Map<string, CrewParentRelation>()
  for (const row of maximal.sort((a, b) => claimKey(a).localeCompare(claimKey(b)))) {
    if (row.family === 'remote') {
      const address = `run:${row.run}`
      const parent: Party = { address, terminalHandle: null, orcaSessionId: null, paneKey: null }
      const key = JSON.stringify([row.home, address])
      managers.set(key, { parent, address, key })
      continue
    }
    const creator = row.creator ? creators.get(row.creator) : undefined
    const parent =
      (creator
        ? registry.party(
            creator.session,
            creator.handle,
            creator.pane,
            `dispatch:${creator.id}`,
            creator.process
          )
        : undefined) ?? registry.party(row.creatorSession, row.creatorHandle, row.creatorPane)
    const coordinator = registry.party(
      row.coordinatorSession,
      row.coordinator,
      row.coordinatorPane,
      `run:${row.run}`
    )
    const chosen = parent?.address !== self.address ? (parent ?? coordinator) : coordinator
    if (!chosen || chosen.address === self.address) {
      continue
    }
    const address =
      chosen === parent ? (creator ? `dispatch:${creator.id}` : chosen.address) : `run:${row.run}`
    const key = JSON.stringify([deps.hostKey, chosen.address])
    if (!managers.has(key)) {
      managers.set(key, {
        parent: chosen,
        address,
        key,
        assignment: creator && chosen === parent ? creatorAssignments.get(creator.id) : undefined
      })
    }
  }
  return [...managers.values()].sort((a, b) => a.key.localeCompare(b.key))
}
