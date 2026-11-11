import type { FileWithMtime } from '../ai-vault/session-scanner-types'
import type { SessionSearchCatalog, SessionSearchCatalogRow } from './session-search-catalog'

type Fact = { file: FileWithMtime; epoch: number; changed: boolean; revision: number }
export type SessionSearchContainerCommand =
  | {
      kind: 'container-apply'
      scope: string
      rows: { file: FileWithMtime; id: string }[]
      epoch: number
      full: boolean
      proof?: number
    }
  | { kind: 'container-drain'; scope: string; limit: number }
  | {
      kind: 'container-ack'
      scope: string
      receipts: { key: string; revision: number }[]
    }
  | {
      kind: 'container-retirement-ack'
      scope: string
      receipts: { key: string; revision: number }[]
    }
  | { kind: 'container-retire'; scope: string; epoch?: number; agent: string; after?: string }

function fact(row: SessionSearchCatalogRow): Fact {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the matching physical-source scope stores only accepted container facts.
  return JSON.parse(row.value) as Fact
}
export function transitionSessionSearchContainer(
  catalog: SessionSearchCatalog,
  command: SessionSearchContainerCommand
): { rows?: SessionSearchCatalogRow[]; after?: string; invalidProof?: boolean } {
  if (command.kind === 'container-ack' || command.kind === 'container-retirement-ack') {
    for (const receipt of command.receipts) {
      const row = catalog.execute({ kind: 'get', scope: command.scope, key: receipt.key }).rows?.[0]
      if (row && fact(row).revision === receipt.revision) {
        if (command.kind === 'container-retirement-ack') {
          catalog.execute({ kind: 'delete', scope: command.scope, key: receipt.key })
          continue
        }
        catalog.execute({
          kind: 'put',
          scope: command.scope,
          rows: [{ ...row, value: JSON.stringify({ ...fact(row), changed: false }), ready: 0 }]
        })
      }
    }
    return {}
  }
  if (command.kind === 'container-apply') {
    let invalidProof = false
    for (const { file, id } of command.rows) {
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
    return { invalidProof }
  }
  const page = catalog.execute({
    kind: 'page',
    scope: command.scope,
    after: command.kind === 'container-retire' ? command.after : undefined,
    ready: command.kind === 'container-drain' ? 1 : undefined,
    limit: command.kind === 'container-drain' ? command.limit : 256
  })
  if (command.kind === 'container-drain') {
    return { rows: page.rows }
  }
  for (const row of page.rows ?? []) {
    if (command.epoch === undefined || fact(row).epoch !== command.epoch) {
      catalog.execute({
        kind: 'put',
        scope: 'container-retirements',
        rows: [
          {
            key: `${command.agent}:${row.key}`,
            value: JSON.stringify({ path: row.key, revision: catalog.nextRevision() }),
            parent: command.agent,
            group: '',
            rank: 0,
            ready: 0
          }
        ]
      })
      catalog.execute({ kind: 'delete', scope: command.scope, key: row.key })
    }
  }
  return { after: page.after }
}
