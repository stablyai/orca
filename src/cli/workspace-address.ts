import { isUnresolvedOwnerHostId, parseExecutionHostId } from '../shared/execution-host'
import { parseWorkspaceKey } from '../shared/workspace-scope'
import type { CrossStoreParentRef } from '../shared/worktree/lineage-types'
import { LOCAL_ENVIRONMENT } from './local-environment-selector'
import type { RuntimeClient } from './runtime-client'
import { quoteCliCommandArgument } from './shell-command-quote'

import {
  formatOwner,
  LOCAL_SERVER,
  ownerOfHostId,
  readOwnerContext,
  serverLabel,
  type OwnerContext,
  type ServerUnknownReason,
  type WorkspaceServer
} from './row-owner-server'

export type { WorkspaceServer }

/** A copyable route to one workspace; `server` is the exact `--server` value. */
export type WorkspaceAddress = { server: string; worktree: string; line: string }

export type AddressUnavailableReason =
  | 'one-off-connection'
  | 'unverifiable-row'
  | 'duplicate-folder-id'

export type WorkspaceParentAnnotation = {
  state: 'known' | 'unknown-server'
  selector: string
  server: WorkspaceServer | null
  address: WorkspaceAddress | null
}

/** `server` owns the row; `address` is the route that answered and a selector it accepts. */
export type WorkspaceAnnotation = {
  server: WorkspaceServer | null
  serverUnknown?: ServerUnknownReason
  address: WorkspaceAddress | null
  addressUnavailable?: AddressUnavailableReason
  parent: WorkspaceParentAnnotation | null
}

/** The row facts an address needs, from a `worktree ps` row or a `worktree show` record. */
export type AddressableRow = {
  id: string
  hostId?: string | null
  identityKey?: string
  parentWorktreeId?: string | null
  parentFolderKey?: string | null
  crossStoreParent?: CrossStoreParentRef | null
}

export type AddressContext = {
  owners: OwnerContext
  /** The caller's own store, read only when some row has a parent in another store. */
  localInstallationId?: string
}

export async function readAddressContext(
  client: RuntimeClient,
  rows: readonly AddressableRow[],
  readLocalInstallationId: () => Promise<string | undefined>
): Promise<AddressContext> {
  const owners = readOwnerContext(client)
  if (!rows.some((row) => row.crossStoreParent)) {
    return { owners }
  }
  // Only the caller's own store is verified here; other servers are never dialed.
  const localInstallationId = await readLocalInstallationId().catch(() => undefined)
  return { owners, localInstallationId }
}

function addressOf(server: string, worktree: string): WorkspaceAddress {
  return {
    server,
    worktree,
    line: `--server ${quoteCliCommandArgument(server)} --worktree ${quoteCliCommandArgument(worktree)}`
  }
}

function folderIdOf(id: string): string | undefined {
  const parsed = parseWorkspaceKey(id)
  return parsed?.type === 'folder' ? parsed.folderWorkspaceId : undefined
}

/** A workspace key recorded on lineage, as the selector `--worktree` takes. */
function selectorOfWorkspaceKey(key: string): string {
  const parsed = parseWorkspaceKey(key)
  return parsed?.type === 'worktree' ? `id:${parsed.worktreeId}` : key
}

type Listing = {
  rowsById: ReadonlyMap<string, readonly AddressableRow[]>
}

function listingOf(rows: readonly AddressableRow[]): Listing {
  const rowsById = new Map<string, AddressableRow[]>()
  for (const row of rows) {
    rowsById.set(row.id, [...(rowsById.get(row.id) ?? []), row])
  }
  return { rowsById }
}

/** The selector naming this row alone on the answering server, or why none can. */
function rowSelector(
  row: AddressableRow,
  listing: Listing
): { selector: string } | { unavailable: AddressUnavailableReason } {
  const sharing = listing.rowsById.get(row.id)?.length ?? 1
  if (isUnresolvedOwnerHostId(row.hostId)) {
    return { unavailable: 'unverifiable-row' }
  }
  if (folderIdOf(row.id) !== undefined) {
    return sharing > 1 ? { unavailable: 'duplicate-folder-id' } : { selector: row.id }
  }
  if (row.identityKey) {
    return { selector: `identity:${row.identityKey}` }
  }
  const host = row.hostId ? parseExecutionHostId(row.hostId) : null
  if (!host || sharing > 1) {
    return { unavailable: 'unverifiable-row' }
  }
  return { selector: `id:${row.id}` }
}

function parentOf(
  row: AddressableRow,
  rowServer: WorkspaceServer | null,
  listing: Listing,
  context: AddressContext
): WorkspaceParentAnnotation | null {
  const route = context.owners.answering.id
  // A same-store parent shares its child's owner.
  const sameServer = (selector: string, parentRow?: AddressableRow) => {
    const resolved = parentRow ? rowSelector(parentRow, listing) : { selector }
    return {
      state: 'known' as const,
      selector,
      server: rowServer,
      address: route && 'selector' in resolved ? addressOf(route, resolved.selector) : null
    }
  }
  if (row.parentWorktreeId) {
    // A worktree parent shares its child's host.
    const parentRow = listing.rowsById
      .get(row.parentWorktreeId)
      ?.find((candidate) => (candidate.hostId ?? null) === (row.hostId ?? null))
    return sameServer(`id:${row.parentWorktreeId}`, parentRow)
  }
  if (row.parentFolderKey) {
    // A listed copy carries the duplicate-folder-id check, so a shared id gets no address.
    return sameServer(row.parentFolderKey, listing.rowsById.get(row.parentFolderKey)?.[0])
  }
  const ref = row.crossStoreParent
  if (!ref) {
    return null
  }
  const selector = selectorOfWorkspaceKey(ref.workspaceKey)
  if (context.localInstallationId && ref.installationId === context.localInstallationId) {
    return {
      state: 'known',
      selector,
      server: LOCAL_SERVER,
      address: addressOf(LOCAL_ENVIRONMENT, selector)
    }
  }
  return { state: 'unknown-server', selector, server: null, address: null }
}

/** Annotations for every row of one listing, aligned by index. */
export function annotateWorkspaces(
  rows: readonly AddressableRow[],
  context: AddressContext
): WorkspaceAnnotation[] {
  const listing = listingOf(rows)
  const route = context.owners.answering.id
  return rows.map((row) => {
    const owner = ownerOfHostId(row.hostId, context.owners)
    const server = owner.server
      ? { server: owner.server }
      : { server: null, serverUnknown: owner.unknown }
    const parent = parentOf(row, owner.server, listing, context)
    if (!route) {
      return { ...server, address: null, addressUnavailable: 'one-off-connection', parent }
    }
    const selected = rowSelector(row, listing)
    return 'selector' in selected
      ? { ...server, address: addressOf(route, selected.selector), parent }
      : { ...server, address: null, addressUnavailable: selected.unavailable, parent }
  })
}

const UNAVAILABLE_TEXT: Record<AddressUnavailableReason, string> = {
  'one-off-connection':
    'unavailable (one-off connection; save it with `orca server add --name <name> --pairing-code <code>`)',
  'unverifiable-row': "unavailable (this row's owner or identity can't be verified)",
  'duplicate-folder-id':
    'unavailable (several folder workspaces share this id; remove one in the Orca app and add its folder again)'
}

/** `server:` and `address:` lines, each on its own line. */
export function formatAddressLines(
  annotation: WorkspaceAnnotation,
  hostId?: string | null
): string {
  const owner = annotation.server
    ? { server: annotation.server }
    : {
        server: null,
        unknown: annotation.serverUnknown ?? ('owner-not-reported' as const),
        stored: hostId ?? null
      }
  return `\nserver: ${formatOwner(owner)}\naddress: ${
    annotation.address?.line ??
    UNAVAILABLE_TEXT[annotation.addressUnavailable ?? 'unverifiable-row']
  }`
}

/** The parent text after `parent: `, naming the parent's server when it differs from the row's. */
export function formatParentText(annotation: WorkspaceAnnotation): string | null {
  const { parent } = annotation
  if (!parent) {
    return null
  }
  if (parent.state === 'unknown-server') {
    return `${parent.selector}  server=unknown (no verified route here)`
  }
  const differs = parent.server?.id !== annotation.server?.id
  return `${parent.selector}${differs ? `  server=${serverLabel(parent.server)}` : ''}`
}

/** The `parent:` line, or nothing when the row has no parent. */
export function formatParentLine(annotation: WorkspaceAnnotation): string {
  const text = formatParentText(annotation)
  return text === null ? '' : `\nparent: ${text}`
}

type PsRowFacts = {
  worktreeId: string
  hostId?: string | null
  identity?: { key: string }
  parentWorktreeId: string | null
  workspaceLineage?: { parentWorkspaceKey: string } | null
  crossStoreParent?: { parent: CrossStoreParentRef }
}

type ShowRecordFacts = {
  id: string
  hostId?: string | null
  identity?: { key: string }
  parentWorktreeId?: string | null
  workspaceLineage?: { parentWorkspaceKey: string } | null
  crossStoreLineage?: { parent: CrossStoreParentRef } | null
}

export function addressableOfPsRow(row: PsRowFacts): AddressableRow {
  return {
    id: row.worktreeId,
    hostId: row.hostId,
    identityKey: row.identity?.key,
    parentWorktreeId: row.parentWorktreeId,
    parentFolderKey: row.workspaceLineage?.parentWorkspaceKey ?? null,
    crossStoreParent: row.crossStoreParent?.parent ?? null
  }
}

export function addressableOfShowRecord(record: ShowRecordFacts): AddressableRow {
  return {
    id: record.id,
    hostId: record.hostId,
    identityKey: record.identity?.key,
    parentWorktreeId: record.parentWorktreeId ?? null,
    parentFolderKey: record.workspaceLineage?.parentWorkspaceKey ?? null,
    crossStoreParent: record.crossStoreLineage?.parent ?? null
  }
}

/** The JSON fields one row gains; the `*Unavailable`/`*Unknown` reasons appear only beside a null. */
export function annotationFields(annotation: WorkspaceAnnotation): WorkspaceAnnotation {
  return {
    server: annotation.server,
    ...(annotation.serverUnknown ? { serverUnknown: annotation.serverUnknown } : {}),
    parent: annotation.parent,
    address: annotation.address,
    ...(annotation.addressUnavailable ? { addressUnavailable: annotation.addressUnavailable } : {})
  }
}

/** Annotates a listing answered by `client`; the caller's own store is read through `localClient`. */
export async function annotateListing(
  client: RuntimeClient,
  localClient: () => RuntimeClient,
  rows: readonly AddressableRow[]
): Promise<WorkspaceAnnotation[]> {
  const context = await readAddressContext(client, rows, async () => {
    const response = await localClient().call<{ installationId?: string }>('worktree.lineageList')
    return response.result.installationId
  })
  return annotateWorkspaces(rows, context).map(annotationFields)
}
