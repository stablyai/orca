import { isUnresolvedOwnerHostId, parseExecutionHostId } from '../../shared/execution-host'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { CrossStoreParentRef } from '../../shared/worktree/lineage-types'
import { LOCAL_ENVIRONMENT } from '../hosts/local-environment-selector'
import type { RuntimeClient } from '../runtime/client'
import { quoteCliCommandArgument } from '../shell-command-quote'

/** Which Orca answered: `local`, a saved environment, or a one-off pairing-code connection (id null). */
export type WorkspaceEnvironment = { id: string | null; name: string | null }

/** A copyable route to one workspace; `environment` is the exact `--environment` value. */
export type WorkspaceAddress = { environment: string; worktree: string; line: string }

export type AddressUnavailableReason =
  | 'one-off-connection'
  | 'unverifiable-row'
  | 'duplicate-folder-id'

export type WorkspaceParentAnnotation = {
  state: 'known' | 'unknown-environment'
  selector: string
  environment: WorkspaceEnvironment | null
  address: WorkspaceAddress | null
}

export type WorkspaceAnnotation = {
  environment: WorkspaceEnvironment
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
  environment: WorkspaceEnvironment
  /** The caller's own store, read only when some row has a parent in another store. */
  localInstallationId?: string
}

const LOCAL: WorkspaceEnvironment = { id: LOCAL_ENVIRONMENT, name: LOCAL_ENVIRONMENT }

/** The environment the client routes to; a saved route is named by its stored id and name. */
export function describeClientEnvironment(client: RuntimeClient): WorkspaceEnvironment {
  if (!client.isRemote) {
    return LOCAL
  }
  const selector = client.environmentSelector
  if (!selector) {
    return { id: null, name: null }
  }
  const saved = listEnvironments(client.userDataPath).find(
    (environment) => environment.id === selector || environment.name === selector
  )
  return saved ? { id: saved.id, name: saved.name } : { id: selector, name: selector }
}

export async function readAddressContext(
  client: RuntimeClient,
  rows: readonly AddressableRow[],
  readLocalInstallationId: () => Promise<string | undefined>
): Promise<AddressContext> {
  const environment = describeClientEnvironment(client)
  if (!rows.some((row) => row.crossStoreParent)) {
    return { environment }
  }
  // Only the caller's own store is verified here; other environments are never dialed.
  const localInstallationId = await readLocalInstallationId().catch(() => undefined)
  return { environment, localInstallationId }
}

export function environmentLabel(environment: WorkspaceEnvironment | null): string {
  return environment?.name ?? 'one-off connection'
}

function addressOf(environment: string, worktree: string): WorkspaceAddress {
  return {
    environment,
    worktree,
    line: `--environment ${quoteCliCommandArgument(environment)} --worktree ${quoteCliCommandArgument(worktree)}`
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

/** The selector naming this row alone in its environment, or why none can. */
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
  listing: Listing,
  context: AddressContext
): WorkspaceParentAnnotation | null {
  const route = context.environment.id
  const sameEnvironment = (selector: string, parentRow?: AddressableRow) => {
    const resolved = parentRow ? rowSelector(parentRow, listing) : { selector }
    return {
      state: 'known' as const,
      selector,
      environment: context.environment,
      address: route && 'selector' in resolved ? addressOf(route, resolved.selector) : null
    }
  }
  if (row.parentWorktreeId) {
    // A worktree parent shares its child's host.
    const parentRow = listing.rowsById
      .get(row.parentWorktreeId)
      ?.find((candidate) => (candidate.hostId ?? null) === (row.hostId ?? null))
    return sameEnvironment(`id:${row.parentWorktreeId}`, parentRow)
  }
  if (row.parentFolderKey) {
    // A listed copy carries the duplicate-folder-id check, so a shared id gets no address.
    return sameEnvironment(row.parentFolderKey, listing.rowsById.get(row.parentFolderKey)?.[0])
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
      environment: LOCAL,
      address: addressOf(LOCAL_ENVIRONMENT, selector)
    }
  }
  return { state: 'unknown-environment', selector, environment: null, address: null }
}

/** Annotations for every row of one listing, aligned by index. */
export function annotateWorkspaces(
  rows: readonly AddressableRow[],
  context: AddressContext
): WorkspaceAnnotation[] {
  const listing = listingOf(rows)
  return rows.map((row) => {
    const parent = parentOf(row, listing, context)
    const route = context.environment.id
    if (!route) {
      return {
        environment: context.environment,
        address: null,
        addressUnavailable: 'one-off-connection',
        parent
      }
    }
    const selected = rowSelector(row, listing)
    return 'selector' in selected
      ? { environment: context.environment, address: addressOf(route, selected.selector), parent }
      : {
          environment: context.environment,
          address: null,
          addressUnavailable: selected.unavailable,
          parent
        }
  })
}

const UNAVAILABLE_TEXT: Record<AddressUnavailableReason, string> = {
  'one-off-connection':
    'unavailable (one-off pairing-code connection; save it with `orca environment add --name <name> --pairing-code <code>`)',
  'unverifiable-row': "unavailable (this row's host or identity can't be verified)",
  'duplicate-folder-id':
    'unavailable (several folder workspaces share this id; remove one in the Orca app and add its folder again)'
}

/** `environment:` and `address:` lines, each on its own line. */
export function formatAddressLines(annotation: WorkspaceAnnotation): string {
  return `\nenvironment: ${environmentLabel(annotation.environment)}\naddress: ${
    annotation.address?.line ??
    UNAVAILABLE_TEXT[annotation.addressUnavailable ?? 'unverifiable-row']
  }`
}

/** The `parent:` line, naming the parent's environment when it differs from the row's. */
export function formatParentLine(annotation: WorkspaceAnnotation): string {
  const { parent } = annotation
  if (!parent) {
    return ''
  }
  if (parent.state === 'unknown-environment') {
    return `\nparent: ${parent.selector}  environment=unknown (no verified route here)`
  }
  const differs = parent.environment?.id !== annotation.environment.id
  return `\nparent: ${parent.selector}${differs ? `  environment=${environmentLabel(parent.environment)}` : ''}`
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

/** The JSON fields one row gains; `addressUnavailable` appears only beside a null address. */
export function annotationFields(annotation: WorkspaceAnnotation): WorkspaceAnnotation {
  return {
    environment: annotation.environment,
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
