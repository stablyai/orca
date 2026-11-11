import type { FileWithMtime } from '../ai-vault/session-scanner-types'
import type { SessionSearchCatalog, SessionSearchCatalogRow } from './session-search-catalog'

export type SessionSearchContainerAuthority = {
  incarnation: number
  revision: number
  state: 'unknown' | 'full' | 'released'
  epoch?: number
}
export type SessionSearchContainerRemoval = {
  scope: string
  agent: string
  incarnation: number
  authority: number
  revision: number
}
export type SessionSearchContainerOmission = Omit<SessionSearchContainerRemoval, 'scope'> & {
  id: string
}

type Fact = { file: FileWithMtime; epoch: number; changed: boolean; revision: number }
export type SessionSearchContainerCommand =
  | {
      kind: 'container-apply'
      scope: string
      rows: { file: FileWithMtime; id: string }[]
      epoch: number
      full: boolean
      proof?: number
      authorityRevision: number
    }
  | { kind: 'container-drain'; scope: string; limit: number }
  | {
      kind: 'container-ack'
      scope: string
      receipts: { key: string; revision: number }[]
    }
  | {
      kind: 'container-retire'
      scope: string
      epoch?: number
      agent: string
      after?: string
      authorityRevision?: number
      authority?: SessionSearchContainerAuthority['state']
      restart?: boolean
      phase?: 'raw' | 'receipts'
    }

export function sessionSearchContainerAuthority(
  catalog: SessionSearchCatalog,
  scope: string
): SessionSearchContainerAuthority | undefined {
  const row = catalog.execute({ kind: 'get', scope: `${scope}:authority`, key: 'current' })
    .rows?.[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the physical source owner writes this control scope.
  return row ? (JSON.parse(row.value) as SessionSearchContainerAuthority) : undefined
}

export function validSessionSearchContainerRemoval(
  catalog: SessionSearchCatalog,
  path: string,
  receipt: SessionSearchContainerRemoval
): boolean {
  const authority = sessionSearchContainerAuthority(catalog, receipt.scope)
  if (
    !authority ||
    authority.state === 'unknown' ||
    authority.incarnation !== receipt.incarnation ||
    authority.revision !== receipt.authority
  ) {
    return false
  }
  const row = catalog.execute({ kind: 'get', scope: `${receipt.scope}:omissions`, key: path })
    .rows?.[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this scope contains only omission receipts.
  const current = row ? (JSON.parse(row.value) as SessionSearchContainerOmission) : undefined
  if (
    !current ||
    current.revision !== receipt.revision ||
    current.authority !== authority.revision ||
    current.incarnation !== authority.incarnation ||
    current.agent !== receipt.agent
  ) {
    return false
  }
  const positive = catalog.execute({ kind: 'get', scope: receipt.scope, key: path }).rows?.[0]
  return authority.state === 'released' || !positive || fact(positive).epoch !== authority.epoch
}

function fact(row: SessionSearchCatalogRow): Fact {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the matching physical-source scope stores only accepted container facts.
  return JSON.parse(row.value) as Fact
}
export function transitionSessionSearchContainer(
  catalog: SessionSearchCatalog,
  command: SessionSearchContainerCommand
): {
  rows?: SessionSearchCatalogRow[]
  after?: string
  invalidProof?: boolean
  authority?: SessionSearchContainerAuthority
  accepted?: boolean
} {
  if (command.kind === 'container-ack') {
    for (const receipt of command.receipts) {
      const row = catalog.execute({ kind: 'get', scope: command.scope, key: receipt.key }).rows?.[0]
      if (row && fact(row).revision === receipt.revision) {
        catalog.execute({
          kind: 'put',
          scope: command.scope,
          rows: [{ ...row, value: JSON.stringify({ ...fact(row), changed: false }), ready: 0 }]
        })
      }
    }
    return {}
  }
  const authority = sessionSearchContainerAuthority(catalog, command.scope)
  if (command.kind === 'container-retire' && command.authority) {
    if (command.authorityRevision !== authority?.revision) {
      return { authority, accepted: false }
    }
    if (
      authority?.state === command.authority &&
      authority.epoch === command.epoch &&
      !command.restart
    ) {
      return { authority, accepted: true }
    }
    const revision = catalog.nextRevision()
    const next: SessionSearchContainerAuthority = {
      incarnation: !authority || command.restart ? revision : authority.incarnation,
      revision,
      state: command.authority,
      epoch: command.epoch
    }
    catalog.execute({
      kind: 'put',
      scope: `${command.scope}:authority`,
      rows: [
        { key: 'current', value: JSON.stringify(next), parent: '', group: '', rank: 0, ready: 0 }
      ]
    })
    return { authority: next, accepted: true }
  }
  if (command.kind !== 'container-drain' && command.authorityRevision !== authority?.revision) {
    return { authority, accepted: false }
  }
  if (command.kind === 'container-apply') {
    let invalidProof = false
    if (!authority) {
      return { accepted: false }
    }
    for (const { file, id } of command.rows) {
      const omitted = catalog.execute({
        kind: 'get',
        scope: `${command.scope}:omissions`,
        key: file.path
      }).rows?.[0]
      if (omitted && (omitted.tie ?? 0) <= authority.incarnation) {
        catalog.execute({ kind: 'delete', scope: `${command.scope}:omissions`, key: file.path })
      }
      const row = catalog.execute({ kind: 'get', scope: command.scope, key: file.path }).rows?.[0]
      const previous = row ? fact(row) : undefined
      invalidProof ||= !!id && command.proof !== undefined && previous?.epoch !== command.proof
      const different =
        !previous ||
        previous.file.mtimeMs !== file.mtimeMs ||
        previous.file.sizeBytes !== file.sizeBytes
      const changed = different || previous?.changed === true
      catalog.execute({
        kind: 'put',
        scope: command.scope,
        rows: [
          {
            key: file.path,
            value: JSON.stringify({
              file,
              epoch: command.full ? command.epoch : (previous?.epoch ?? 0),
              changed,
              revision: different ? catalog.nextRevision() : previous?.revision
            }),
            parent: '',
            group: id,
            rank: 0,
            ready: Number(changed)
          }
        ]
      })
    }
    return { invalidProof, accepted: true }
  }
  if (command.kind === 'container-retire' && (!authority || authority.state === 'unknown')) {
    return { accepted: false, authority }
  }
  const receipts = command.kind === 'container-retire' && command.phase === 'receipts'
  const page = catalog.execute({
    kind: 'page',
    scope: receipts ? `${command.scope}:omissions` : command.scope,
    after: command.kind === 'container-retire' ? command.after : undefined,
    ready: command.kind === 'container-drain' ? 1 : undefined,
    limit: command.kind === 'container-drain' ? command.limit : 256
  })
  if (command.kind === 'container-drain') {
    return { rows: page.rows }
  }
  for (const row of page.rows ?? []) {
    const positive = receipts
      ? catalog.execute({ kind: 'get', scope: command.scope, key: row.key }).rows?.[0]
      : row
    if (authority!.state === 'full' && positive && fact(positive).epoch === authority!.epoch) {
      if (receipts) {
        catalog.execute({ kind: 'delete', scope: `${command.scope}:omissions`, key: row.key })
      }
      continue
    }
    const value: SessionSearchContainerOmission = {
      id: receipts ? row.parent : row.group,
      agent: command.agent,
      incarnation: authority!.incarnation,
      authority: authority!.revision,
      revision: catalog.nextRevision()
    }
    catalog.execute({
      kind: 'put',
      scope: `${command.scope}:omissions`,
      rows: [
        {
          key: row.key,
          value: JSON.stringify(value),
          parent: value.id,
          group: '',
          rank: 0,
          ready: 1,
          tie: value.incarnation
        }
      ]
    })
    if (!receipts) {
      catalog.execute({ kind: 'delete', scope: command.scope, key: row.key })
    }
  }
  return { after: page.after, accepted: true, authority }
}
