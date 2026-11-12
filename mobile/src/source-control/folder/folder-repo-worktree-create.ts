import { WORKTREE_CREATE_EXACT_NAME_TAKEN_CODE } from '../../../../src/shared/new-workspace/worktree-create-collision'
import { hasRuntimeRpcErrorCode } from '../../../../src/shared/runtime-rpc-error-code'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { isRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'
import { readNewWorktreeRuntimeCapabilities } from '../../new-workspace/creation/worktree-create-capability'
import { createWorktreeWithNameRetry } from '../../new-workspace/creation/worktree-create-retry'

// The host's refusal before creating, when the repo asks to run or skip setup; desktop matches the same text.
const SETUP_DECISION_REQUIRED = 'Setup decision required for this repository'

// How long a created or unconfirmed card stays busy waiting for the list; the outcome itself is kept until it shows.
const HELD_BUSY_MS = 15_000

/** One repository of one folder on one host. */
export type FolderRepoTarget = {
  hostId: string
  /** The folder's server; undefined for the paired desktop's own. */
  executionHost: string | undefined
  /** `folder:<id>`. */
  folderWorktreeId: string
  repoId: string
}

type Phase =
  /** The direct exact-name create is out. */
  | 'creating'
  /** Refused before creating; a composer for it is open and nothing has been sent from it. */
  | 'composing'
  /** The composer sent its create. */
  | 'submitting'
  /** Created, or possibly created: kept until the folder's members show it. */
  | 'held'

/**
 * `name` is the exact name a direct create was sent as, so an unresolved one is retried as itself.
 * A composer's create may have used another name or branch, so it is never resent from a card.
 */
type Operation = FolderRepoTarget & {
  id: number
  phase: Phase
  busy: boolean
  name: string
  origin: 'direct' | 'composer'
}

// In memory and shared across screens, so a remount or a reopened composer can't send a second create.
const operations = new Map<string, Operation>()
const listeners = new Set<() => void>()
let nextId = 1
let version = 0

function notify(): void {
  version += 1
  listeners.forEach((listener) => listener())
}

export function folderRepoCreateKey(target: FolderRepoTarget): string {
  return [target.hostId, target.executionHost ?? '', target.folderWorktreeId, target.repoId].join(
    '\0'
  )
}

export function subscribeFolderRepoCreates(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getFolderRepoCreatesVersion(): number {
  return version
}

/** The card shows a spinner and takes no taps while its repository's create is busy. */
export function isFolderRepoCreateBusy(target: FolderRepoTarget): boolean {
  return operations.get(folderRepoCreateKey(target))?.busy === true
}

function start(
  target: FolderRepoTarget,
  phase: Phase,
  name: string,
  origin: Operation['origin']
): Operation {
  const operation = { ...target, id: nextId++, phase, busy: true, name, origin }
  operations.set(folderRepoCreateKey(target), operation)
  notify()
  return operation
}

function isCurrent(operation: Operation): boolean {
  return operations.get(folderRepoCreateKey(operation))?.id === operation.id
}

function release(operation: Operation): void {
  if (isCurrent(operation)) {
    operations.delete(folderRepoCreateKey(operation))
    notify()
  }
}

function hold(operation: Operation, busy = true): number | undefined {
  if (!isCurrent(operation)) {
    return undefined
  }
  // A new identity, so an earlier hold's timer can't end this one.
  const held = { ...operation, id: nextId++, phase: 'held' as const, busy }
  operations.set(folderRepoCreateKey(held), held)
  notify()
  if (!busy) {
    return held.id
  }
  setTimeout(() => {
    if (isCurrent(held)) {
      operations.set(folderRepoCreateKey(held), { ...held, busy: false })
      notify()
    }
  }, HELD_BUSY_MS)
  return held.id
}

/** Whether `hold` is still this repository's unconfirmed direct create, waiting for a setup choice. */
export function isFolderRepoHoldPending(target: FolderRepoTarget, hold: number): boolean {
  const operation = operations.get(folderRepoCreateKey(target))
  return operation?.id === hold && operation.phase === 'held' && operation.origin === 'direct'
}

/** Forgets created or unconfirmed creates once the folder lists a worktree from that repository on that host. */
export function reconcileFolderRepoCreates(
  folder: Pick<FolderRepoTarget, 'hostId' | 'executionHost' | 'folderWorktreeId'>,
  members: readonly { repoId: string; hostId?: string }[]
): void {
  let changed = false
  for (const [key, operation] of operations) {
    if (
      operation.phase === 'held' &&
      operation.hostId === folder.hostId &&
      operation.executionHost === folder.executionHost &&
      operation.folderWorktreeId === folder.folderWorktreeId &&
      members.some(
        (member) =>
          member.repoId === operation.repoId &&
          (member.hostId?.startsWith('runtime:') ? member.hostId : undefined) ===
            operation.executionHost
      )
    ) {
      operations.delete(key)
      changed = true
    }
  }
  if (changed) {
    notify()
  }
}

export type FolderRepoCreateOutcome =
  | { kind: 'created'; name: string; warning?: string }
  /** Refused before creating: a branch with that name exists, or the repo asks to run or skip setup. The repository stays reserved for the composer. */
  | { kind: 'needs-composer'; reservation: number }
  /** The host may have created it: the reply was lost, or a resend was refused as taken. */
  | { kind: 'maybe-created' }
  /** An unconfirmed create's resend needs a setup choice; it is resent as the same exact name with it. */
  | { kind: 'needs-setup-choice'; hold: number }
  /** A composer's create is unconfirmed: nothing is sent, the folder is checked until it lists it. */
  | { kind: 'checking' }
  | { kind: 'failed'; message: string }
  | { kind: 'already-running' }

/**
 * Creates a worktree named after the folder in one of its repositories, attached to the folder, the
 * way desktop's empty state does. Only for hosts that advertise exact-name creation.
 */
export async function createFolderRepoWorktree(args: {
  target: FolderRepoTarget
  /** The client that creates: the desktop's own, or scoped to the folder's server. */
  client: RpcClient
  name: string
  /** Resends this unconfirmed hold without setup; nothing is sent once the folder shows it or it is replaced. */
  skipSetupFor?: number
}): Promise<FolderRepoCreateOutcome> {
  const existing = operations.get(folderRepoCreateKey(args.target))
  const staleResend =
    args.skipSetupFor !== undefined && !isFolderRepoHoldPending(args.target, args.skipSetupFor)
  if (!staleResend && existing && (existing.phase !== 'held' || existing.busy)) {
    return { kind: 'already-running' }
  }
  if (staleResend || existing?.origin === 'composer') {
    return { kind: 'checking' }
  }
  // An unconfirmed create is retried as the same exact name, even after a rename: a taken name may be its own.
  const unresolved = existing !== undefined
  const name = existing?.name ?? args.name
  const operation = start(args.target, 'creating', name, 'direct')
  const settleUnresolved = (outcome: FolderRepoCreateOutcome): FolderRepoCreateOutcome => {
    hold(operation)
    return outcome
  }
  try {
    const result = await createWorktreeWithNameRetry({
      client: args.client,
      baseName: name,
      // One exact name: a numbered suffix would be a worktree the user didn't ask for.
      maxAttempts: 1,
      branchIntentSupported: true,
      worktreeCreateIdempotency: readNewWorktreeRuntimeCapabilities(args.client).then(
        (capabilities) => capabilities?.worktreeCreateIdempotency ?? false
      ),
      buildParams: (name) => ({
        repo: `id:${args.target.repoId}`,
        name,
        displayName: name,
        displayNameKind: 'user',
        branchIntent: 'create-exact',
        setupDecision: args.skipSetupFor === undefined ? 'inherit' : 'skip',
        parentWorkspace: args.target.folderWorktreeId,
        parentWorkspaceOrigin: 'manual'
      })
    })
    if (!('error' in result)) {
      hold(operation)
      return {
        kind: 'created',
        name: result.name,
        ...(result.warning ? { warning: result.warning } : {})
      }
    }
    const taken = hasRuntimeRpcErrorCode(result.error, WORKTREE_CREATE_EXACT_NAME_TAKEN_CODE)
    if (taken && (result.replayed || unresolved)) {
      return settleUnresolved({ kind: 'maybe-created' })
    }
    const needsSetup = result.error.includes(SETUP_DECISION_REQUIRED)
    if (unresolved && needsSetup) {
      // That refusal did no git work, but says nothing about the earlier create; it stays unconfirmed.
      const held = hold(operation, false)
      return held === undefined
        ? { kind: 'maybe-created' }
        : { kind: 'needs-setup-choice', hold: held }
    }
    if (unresolved) {
      return settleUnresolved({ kind: 'failed', message: result.error })
    }
    if (taken || needsSetup) {
      const reserved = { ...operation, phase: 'composing' as const }
      operations.set(folderRepoCreateKey(reserved), reserved)
      notify()
      return { kind: 'needs-composer', reservation: reserved.id }
    }
    release(operation)
    return { kind: 'failed', message: result.error }
  } catch (error) {
    // Delivery unknown: the host may have created it, and a fresh create would be refused as taken.
    if (isRpcDeliveryUnknown(error) || unresolved) {
      return settleUnresolved({ kind: 'maybe-created' })
    }
    release(operation)
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/** A composer closed before sending anything gives its repository back. */
export function releaseFolderComposerReservation(
  target: FolderRepoTarget,
  reservation: number
): void {
  const operation = operations.get(folderRepoCreateKey(target))
  if (operation?.id === reservation && operation.phase === 'composing') {
    release(operation)
  }
}

export type FolderComposerSubmission = {
  /** `created` and `uncertain` are kept until the folder shows them; `failed` and `cancelled` give the repository back. */
  settle: (outcome: 'created' | 'uncertain' | 'failed' | 'cancelled') => void
}

/**
 * Admits the composer's create for the repository it actually picked, before anything is sent.
 * Null while another create for that repository is out.
 */
export function beginFolderComposerSubmission(
  target: FolderRepoTarget,
  launch: { target: FolderRepoTarget; reservation: number; name: string },
  /** Whether the composer is still open to retry a refused create. */
  formOpen: () => boolean
): FolderComposerSubmission | null {
  const key = folderRepoCreateKey(target)
  const existing = operations.get(key)
  const ownsReservation =
    key === folderRepoCreateKey(launch.target) &&
    existing?.id === launch.reservation &&
    existing.phase === 'composing'
  if (existing && !ownsReservation) {
    return null
  }
  const operation = start(target, 'submitting', launch.name, 'composer')
  return {
    settle: (outcome) => {
      if (outcome === 'created' || outcome === 'uncertain') {
        hold(operation)
        return
      }
      // A refusal leaves the form to try again; the reservation is back with the launch's repository.
      if (ownsReservation && formOpen() && isCurrent(operation)) {
        const reserved = { ...operation, phase: 'composing' as const, id: launch.reservation }
        operations.set(key, reserved)
        notify()
        return
      }
      release(operation)
    }
  }
}
