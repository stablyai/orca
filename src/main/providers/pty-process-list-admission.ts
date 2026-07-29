import { isAgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import { MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES } from '../../shared/claimed-agent-pty-owner'
import { cloneAgentSessionOwnerBinding } from '../../shared/claimed-agent-pty-owner-snapshot'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtyProcessInfo } from './types'

export const MAX_AGGREGATED_PTY_PROCESS_LIST_ENTRIES = 4096
export const MAX_AGGREGATED_PTY_PROCESS_LIST_BYTES = 32 * 1024 * 1024
export const MAX_AGGREGATED_PTY_PROCESS_LIST_OWNERS = MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES
export const PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE = 4

function retainedStringBytes(value: unknown): number | null {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : null
}

function retainedOptionalStringBytes(value: unknown): number | null {
  return value === undefined ? 0 : retainedStringBytes(value)
}

function retainedOwnerBytes(owner: unknown, ptyId: string): number | null {
  if (!isAgentSessionOwnerBinding(owner) || owner.phase !== 'live' || owner.ptyId !== ptyId) {
    return null
  }
  return [
    owner.claim.keyId,
    owner.claim.identityDigest,
    owner.claim.worktreeScopeDigest,
    owner.claim.agent,
    owner.generation,
    owner.ptyId,
    owner.surface.worktreeId,
    owner.surface.tabId,
    owner.surface.leafId,
    owner.surface.terminalHandle
  ].reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0)
}

export class PtyProcessListAdmission {
  private entries = 0
  private retainedBytes = 0
  private owners = 0

  constructor(private readonly capacityError = 'pty_process_list_capacity') {}

  admit(value: PtyProcessInfo): PtyProcessInfo {
    if (typeof value !== 'object' || value === null) {
      throw new Error('invalid_pty_process_list')
    }
    const idBytes = retainedStringBytes(value.id)
    const cwdBytes = retainedStringBytes(value.cwd)
    const titleBytes = retainedStringBytes(value.title)
    const worktreeIdBytes = retainedOptionalStringBytes(value.worktreeId)
    const terminalHandleBytes = retainedOptionalStringBytes(value.terminalHandle)
    const wslDistroBytes =
      value.wslDistro === null ? 0 : retainedOptionalStringBytes(value.wslDistro)
    if (
      idBytes === null ||
      cwdBytes === null ||
      titleBytes === null ||
      worktreeIdBytes === null ||
      terminalHandleBytes === null ||
      wslDistroBytes === null ||
      (value.incarnationId !== undefined && !isPtyIncarnationId(value.incarnationId)) ||
      (value.agentSessionOwners !== undefined && !Array.isArray(value.agentSessionOwners))
    ) {
      throw new Error('invalid_pty_process_list')
    }
    if (
      (value.agentSessionOwners?.length ?? 0) >
      MAX_AGGREGATED_PTY_PROCESS_LIST_OWNERS - this.owners
    ) {
      throw new Error(this.capacityError)
    }

    let ownerBytes = 0
    const normalizedOwners = value.agentSessionOwners?.map((owner) => {
      const bytes = retainedOwnerBytes(owner, value.id)
      if (bytes === null) {
        throw new Error('agent_session_ownership_unknown')
      }
      ownerBytes += bytes
      return cloneAgentSessionOwnerBinding(owner)
    })
    const nextEntries = this.entries + 1
    const nextOwners = this.owners + (normalizedOwners?.length ?? 0)
    const nextBytes =
      this.retainedBytes +
      idBytes +
      cwdBytes +
      titleBytes +
      worktreeIdBytes +
      terminalHandleBytes +
      wslDistroBytes +
      ownerBytes
    if (
      nextEntries > MAX_AGGREGATED_PTY_PROCESS_LIST_ENTRIES ||
      nextOwners > MAX_AGGREGATED_PTY_PROCESS_LIST_OWNERS ||
      nextBytes > MAX_AGGREGATED_PTY_PROCESS_LIST_BYTES
    ) {
      throw new Error(this.capacityError)
    }
    this.entries = nextEntries
    this.owners = nextOwners
    this.retainedBytes = nextBytes

    return {
      id: value.id,
      cwd: value.cwd,
      title: value.title,
      ...(value.incarnationId !== undefined ? { incarnationId: value.incarnationId } : {}),
      ...(value.worktreeId !== undefined ? { worktreeId: value.worktreeId } : {}),
      ...(value.terminalHandle !== undefined ? { terminalHandle: value.terminalHandle } : {}),
      ...(value.wslDistro !== undefined ? { wslDistro: value.wslDistro } : {}),
      ...(normalizedOwners !== undefined ? { agentSessionOwners: normalizedOwners } : {})
    }
  }
}

export async function visitPtyProcessListingsInBatches<T>(
  sources: Iterable<T>,
  load: (source: T) => Promise<readonly PtyProcessInfo[]>,
  visit: (source: T, processes: readonly PtyProcessInfo[]) => void
): Promise<void> {
  let batch: T[] = []
  for (const source of sources) {
    batch.push(source)
    if (batch.length < PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE) {
      continue
    }
    const listings = await Promise.all(
      batch.map(async (entry) => ({ entry, processes: await load(entry) }))
    )
    for (const listing of listings) {
      visit(listing.entry, listing.processes)
    }
    batch = []
  }
  if (batch.length === 0) {
    return
  }
  const listings = await Promise.all(
    batch.map(async (entry) => ({ entry, processes: await load(entry) }))
  )
  for (const listing of listings) {
    visit(listing.entry, listing.processes)
  }
}

export async function collectPtyProcessListings<T>(
  sources: Iterable<T>,
  load: (source: T) => Promise<readonly PtyProcessInfo[]>
): Promise<PtyProcessInfo[]> {
  const admission = new PtyProcessListAdmission()
  const processes: PtyProcessInfo[] = []
  await visitPtyProcessListingsInBatches(sources, load, (_source, listing) => {
    for (const process of listing) {
      processes.push(admission.admit(process))
    }
  })
  return processes
}
