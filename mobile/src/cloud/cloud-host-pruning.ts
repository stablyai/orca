import { CloudRequestError } from './cloud-control-plane-request'
import { removeCloudPromptsFor } from './cloud-prompt-queue'
import { CloudAttachError } from './cloud-workspace-attach'
import {
  cloudWorkspaceLinkEntries,
  restoreCloudWorkspaceLinks,
  takeCloudWorkspaceLinks,
  type TakenCloudWorkspaceLink
} from './cloud-workspace-links'

// A paired cloud workspace whose VM is gone would otherwise be retried by the phone forever. A
// workspace is forgotten only on a confirmed answer that it no longer exists for this phone: the
// team registry's own GET for it says not_found, or wake says not_found. Missing from a list only
// nominates it (lists are capped and skip hidden rows). Network errors, timeouts, server errors and
// 401s (the session's own path) never prune.

/** The control plane's confirmed answer that this workspace no longer exists for this phone. */
export function isCloudWorkspaceGone(error: unknown): boolean {
  if (error instanceof CloudAttachError) {
    return error.code === 'not_found'
  }
  return error instanceof CloudRequestError && error.status === 404 && error.code === 'not_found'
}

async function forget(
  taken: readonly TakenCloudWorkspaceLink[],
  removeHost: (hostId: string) => Promise<void>
): Promise<string[]> {
  const kept: TakenCloudWorkspaceLink[] = []
  for (const link of taken) {
    if (link.hostId) {
      try {
        await removeHost(link.hostId)
      } catch {
        // A host still in the catalog with no link would be retried forever and unreachable by a
        // later prune or sign-out: put the link back so the next confirmed miss tries again.
        kept.push(link)
      }
    }
  }
  if (kept.length > 0) {
    await restoreCloudWorkspaceLinks(kept)
  }
  const ids = taken.filter((link) => !kept.includes(link)).map((link) => link.sandboxId)
  if (ids.length > 0) {
    await removeCloudPromptsFor(new Set(ids))
  }
  return ids
}

/**
 * After a successful list: every linked workspace the list lacks is checked by id (`confirmGone`),
 * and forgotten only if that says it is gone. A link written after the list request started (a
 * workspace created or paired meanwhile) is never a candidate.
 */
export function pruneCloudHostsMissingFrom(
  listedIds: ReadonlySet<string>,
  listStartedAt: number,
  confirmGone: (sandboxId: string) => Promise<boolean>,
  removeHost: (hostId: string) => Promise<void>
): Promise<string[]> {
  // Single-flight: list polls overlap, and the next poll runs again with its own list anyway.
  inFlight ??= prune(listedIds, listStartedAt, confirmGone, removeHost).finally(() => {
    inFlight = null
  })
  return inFlight
}

// A workspace the registry still serves while the list lacks it (hidden row, past the list cap)
// would otherwise cost one GET per poll forever: its "present" answer holds for a while.
const PRESENT_TTL_MS = 5 * 60_000
const presentUntil = new Map<string, number>()
let inFlight: Promise<string[]> | null = null

async function prune(
  listedIds: ReadonlySet<string>,
  listStartedAt: number,
  confirmGone: (sandboxId: string) => Promise<boolean>,
  removeHost: (hostId: string) => Promise<void>
): Promise<string[]> {
  const isCandidate = (sandboxId: string, link: { updatedAt?: number; pairedAt?: number }) =>
    !listedIds.has(sandboxId) && (link.updatedAt ?? link.pairedAt ?? 0) < listStartedAt
  const now = Date.now()
  const candidates = (await cloudWorkspaceLinkEntries()).filter(
    ([id, link]) => isCandidate(id, link) && (presentUntil.get(id) ?? 0) <= now
  )
  const gone = new Set<string>()
  for (const [sandboxId] of candidates) {
    const answer = await confirmGone(sandboxId).catch(() => null)
    if (answer === true) {
      gone.add(sandboxId)
    } else if (answer === false) {
      // Only a real "still there" is remembered; a failed check is retried next poll.
      presentUntil.set(sandboxId, now + PRESENT_TTL_MS)
    }
  }
  if (gone.size === 0) {
    return []
  }
  // Re-check inside the write: a pairing recorded during the confirmation is kept.
  const taken = await takeCloudWorkspaceLinks(
    (sandboxId, link) => gone.has(sandboxId) && isCandidate(sandboxId, link)
  )
  return forget(taken, removeHost)
}

/** One workspace answered not_found to wake: forget its pairing now. */
export async function pruneGoneCloudHost(
  sandboxId: string,
  removeHost: (hostId: string) => Promise<void>
): Promise<string[]> {
  const taken = await takeCloudWorkspaceLinks((id) => id === sandboxId)
  return forget(taken, removeHost)
}
