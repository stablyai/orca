import { isUnresolvedOwnerHostId, parseExecutionHostId } from '../shared/execution-host'
import { listEnvironments } from '../shared/remote-runtime/host-store/runtime-environment-store'
import { LOCAL_ENVIRONMENT } from './local-environment-selector'
import type { RuntimeClient } from './runtime-client'
import { quoteCliCommandArgument } from './shell-command-quote'

/** An Orca server: `local`, a saved server, or a one-off pairing-code connection (id and name null). */
export type WorkspaceServer = { id: string | null; name: string | null }

/** Why a row's owning server is not named; Orca never guesses one. */
export type ServerUnknownReason =
  | 'conflicting-ownership'
  | 'unverified-owner'
  | 'legacy-ssh-row'
  | 'owner-not-reported'

export type RowOwner =
  | { server: WorkspaceServer }
  | { server: null; unknown: ServerUnknownReason; stored: string | null }

export type OwnerContext = {
  /** The server that answered the listing. */
  answering: WorkspaceServer
  /** Saved servers by id, from this computer's store. */
  savedServer: (id: string) => WorkspaceServer | undefined
}

export const LOCAL_SERVER: WorkspaceServer = { id: LOCAL_ENVIRONMENT, name: LOCAL_ENVIRONMENT }

/** The server the client routes to; a saved route is named by its stored id and name. */
export function describeClientServer(client: RuntimeClient): WorkspaceServer {
  if (!client.isRemote) {
    return LOCAL_SERVER
  }
  const selector = client.environmentSelector
  if (!selector) {
    return { id: null, name: null }
  }
  const saved = listEnvironments(client.userDataPath).find(
    (server) => server.id === selector || server.name === selector
  )
  return saved ? { id: saved.id, name: saved.name } : { id: selector, name: selector }
}

export function readOwnerContext(client: RuntimeClient): OwnerContext {
  const answering = describeClientServer(client)
  let saved: Map<string, WorkspaceServer> | undefined
  return {
    answering,
    savedServer: (id) => {
      saved ??= new Map(
        listEnvironments(client.userDataPath).map((server) => [
          server.id,
          { id: server.id, name: server.name }
        ])
      )
      return saved.get(id)
    }
  }
}

/** The server that owns a row with this stored host id, or why it can't be named here. */
/** Stamps are relative to the store that wrote them; only the local answer shares this computer's. */
function savedServerInAnswerNamespace(
  id: string,
  context: OwnerContext
): WorkspaceServer | undefined {
  return context.answering.id === LOCAL_ENVIRONMENT ? context.savedServer(id) : undefined
}

export function ownerOfHostId(hostId: string | null | undefined, context: OwnerContext): RowOwner {
  const stored = hostId?.trim() || null
  if (!stored) {
    return { server: null, unknown: 'owner-not-reported', stored }
  }
  if (isUnresolvedOwnerHostId(stored)) {
    return { server: null, unknown: 'conflicting-ownership', stored }
  }
  const parsed = parseExecutionHostId(stored)
  if (parsed?.kind === 'local') {
    return { server: context.answering }
  }
  if (parsed?.kind === 'ssh') {
    return { server: null, unknown: 'legacy-ssh-row', stored }
  }
  const saved =
    parsed?.kind === 'runtime'
      ? savedServerInAnswerNamespace(parsed.environmentId, context)
      : undefined
  return saved ? { server: saved } : { server: null, unknown: 'unverified-owner', stored }
}

/** Orchestration projections name the home coordinator `local` and other owners by a bare id. */
export function ownerOfWorkerHost(
  host: { kind?: 'local' | 'remote'; id: string },
  context: OwnerContext
): RowOwner {
  if (host.kind === 'local' || (host.kind === undefined && host.id === LOCAL_ENVIRONMENT)) {
    return { server: context.answering }
  }
  const saved = savedServerInAnswerNamespace(host.id, context)
  return saved ? { server: saved } : { server: null, unknown: 'unverified-owner', stored: host.id }
}

export function serverLabel(server: WorkspaceServer | null): string {
  return server?.name ?? 'one-off connection'
}

function unknownDetail(owner: Extract<RowOwner, { server: null }>): string {
  switch (owner.unknown) {
    case 'conflicting-ownership':
      return 'conflicting ownership'
    case 'legacy-ssh-row':
      return `legacy SSH row ${owner.stored}`
    case 'owner-not-reported':
      return 'owner not reported'
    case 'unverified-owner':
      return `stored ${owner.stored}; owner not verified`
  }
}

/** The owner as printed after `server:` or `server=`. */
export function formatOwner(owner: RowOwner): string {
  return owner.server ? serverLabel(owner.server) : `unknown (${unknownDetail(owner)})`
}

/** `server=<name>` for one listing row; a name that would split the row is quoted. */
export function formatOwnerToken(owner: RowOwner): string {
  return `server=${owner.server ? quoteCliCommandArgument(serverLabel(owner.server)) : formatOwner(owner)}`
}

/** A row's `server=` token, or none when no owner context was given. */
export function ownerTokenOf(
  hostId: string | null | undefined,
  context: OwnerContext | undefined
): string {
  return context ? `  ${formatOwnerToken(ownerOfHostId(hostId, context))}` : ''
}
