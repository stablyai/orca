// A create cancelled while its request was in flight may still have made a sandbox on the control
// plane, and a sandbox bills (GH-CREATE-CANCEL). The control plane keys creates by Idempotency-Key
// and body: sending the same create again hands back the sandbox the first one made (or makes one, if
// the first never arrived), and that sandbox is deleted. Shared by the owned create (the recipe) and
// the GitHub-only create, which both go through createSandboxWithProgress.
// EP-5: while the first create still runs, the replay answers 409; the sandbox it is making is found
// by its workspace id and deleted directly (the control plane accepts a delete mid-create and the
// create then frees its VM), so a cancel doesn't wait out the create. Only a confirmed delete (or
// a refused create, which made nothing) counts as cleaned up.
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'

type CreateBody = Parameters<HostedSandboxControlPlaneClient['create']>[0]
export type ReclaimClient = Pick<HostedSandboxControlPlaneClient, 'create' | 'destroy' | 'list'>

/** 2 min at 5 s: past a create's longest run, under the cancel toast's 3 min limit. */
const RECLAIM_ATTEMPTS = 24
const RECLAIM_WAIT_MS = 5_000

/** The first create may still be running (409 in progress) or the service briefly unreachable. */
function worthRetrying(error: unknown): boolean {
  return (
    isEnvironmentProviderError(error, 'conflict') ||
    isEnvironmentProviderError(error, 'unavailable') ||
    isEnvironmentProviderError(error, 'timeout') ||
    !isEnvironmentProviderError(error)
  )
}

/**
 * Deletes whatever the cancelled create made. True once it is gone (or the control plane refused
 * the create, so nothing was made); false when it still couldn't tell after every attempt.
 */
export async function reclaimCancelledCreate(
  client: ReclaimClient,
  body: CreateBody,
  idempotencyKey: string,
  {
    attempts = RECLAIM_ATTEMPTS,
    waitMs = RECLAIM_WAIT_MS,
    log = (message: string) => console.warn(message)
  }: { attempts?: number; waitMs?: number; log?: (message: string) => void } = {}
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let sandboxId: string
    try {
      // No signal: this request is the cleanup and must not be cancelled with the create.
      sandboxId = (await client.create(body, undefined, idempotencyKey)).sandbox.id
    } catch (error) {
      if (!worthRetrying(error)) {
        // Refused (billing, sign-in, bad request): the cancelled create made nothing either.
        return true
      }
      log(
        `[orca-cloud] cancelled create: replay ${attempt}/${attempts} failed (${isEnvironmentProviderError(error) ? error.code : 'error'})`
      )
      if (
        isEnvironmentProviderError(error, 'conflict') &&
        (await deleteByWorkspace(client, body.workspaceId, log))
      ) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      continue
    }
    if (await deleted(client, sandboxId, log)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  log('[orca-cloud] cancelled create: could not confirm the sandbox was deleted')
  return false
}

/** True once the control plane answers the delete with the sandbox destroyed. */
async function deleted(
  client: ReclaimClient,
  sandboxId: string,
  log: (message: string) => void
): Promise<boolean> {
  try {
    const gone = await client.destroy(sandboxId)
    if (gone.status === 'destroyed') {
      log(`[orca-cloud] cancelled create: deleted sandbox ${sandboxId}`)
      return true
    }
  } catch {
    // Retried with the next attempt.
  }
  return false
}

/** The create still running: delete the sandbox it is making, found by the create's workspace id. */
async function deleteByWorkspace(
  client: ReclaimClient,
  workspaceId: string,
  log: (message: string) => void
): Promise<boolean> {
  const sandboxes = await client.list().catch(() => null)
  const live = sandboxes?.filter(
    (sandbox) => sandbox.workspaceId === workspaceId && sandbox.status !== 'destroyed'
  )
  if (!live || live.length === 0) {
    // Not listed yet (or the list failed): the next replay tries again.
    return false
  }
  const results = await Promise.all(live.map((sandbox) => deleted(client, sandbox.id, log)))
  return results.every(Boolean)
}
