// A create cancelled while its request was in flight may still have made a sandbox on the control
// plane, and a sandbox bills (GH-CREATE-CANCEL). The control plane keys creates by Idempotency-Key
// and body: sending the same create again hands back the sandbox the first one made (or makes one, if
// the first never arrived), and that sandbox is deleted. Shared by the owned create (the recipe) and
// the GitHub-only create, which both go through createSandboxWithProgress.
// EP-5: while the first create still runs, the replay answers 409; the sandbox it is making is found
// by its workspace id and deleted directly. Deleting it mid-create could leave that create to retry
// with a new row (pooled adopt, region fallback; n48), so the replays go on until the create itself
// has answered (its sandbox, `create_cancelled`, or a refusal), and a final sweep of the workspace
// deletes anything of it still up. Only that confirmed sweep counts as cleaned up.
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'

type CreateBody = Parameters<HostedSandboxControlPlaneClient['create']>[0]
export type ReclaimClient = Pick<HostedSandboxControlPlaneClient, 'create' | 'destroy' | 'list'>

/** 2 min at 5 s: past a create's longest run, under the cancel toast's 3 min limit. */
const RECLAIM_ATTEMPTS = 24
const RECLAIM_WAIT_MS = 5_000
/** The control plane's stored answer to a replay of a create its owner deleted mid-way. */
const CREATE_CANCELLED = 'create_cancelled'

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
 * Deletes whatever the cancelled create made. True once its workspace has nothing left running
 * (or the control plane refused the create, so nothing was made); false when it still couldn't
 * tell after every attempt.
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
  const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, waitMs))
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let sandboxId: string
    try {
      // No signal: this request is the cleanup and must not be cancelled with the create.
      sandboxId = (await client.create(body, undefined, idempotencyKey)).sandbox.id
    } catch (error) {
      const cancelled =
        isEnvironmentProviderError(error, 'conflict') && error.reason === CREATE_CANCELLED
      if (cancelled || !worthRetrying(error)) {
        // The create has answered: stopped by our delete, or refused (billing, sign-in, bad
        // request) so this replay made nothing. Whatever the first one made is swept.
        if (await workspaceClear(client, body.workspaceId, log)) {
          return true
        }
        await wait()
        continue
      }
      log(
        `[orca-cloud] cancelled create: replay ${attempt}/${attempts} failed (${isEnvironmentProviderError(error) ? error.code : 'error'})`
      )
      if (isEnvironmentProviderError(error, 'conflict')) {
        // Still running: delete what it is making now; the create answers once it has stopped.
        await workspaceClear(client, body.workspaceId, log)
      }
      await wait()
      continue
    }
    if (
      (await deleted(client, sandboxId, log)) &&
      (await workspaceClear(client, body.workspaceId, log))
    ) {
      return true
    }
    await wait()
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

/**
 * Deletes every sandbox of the cancelled create's workspace still listed. True when none is left
 * (all deleted, or none listed); false when the list couldn't be read or a delete didn't land.
 */
async function workspaceClear(
  client: ReclaimClient,
  workspaceId: string,
  log: (message: string) => void
): Promise<boolean> {
  const sandboxes = await client.list().catch(() => null)
  if (!sandboxes) {
    return false
  }
  const live = sandboxes.filter(
    (sandbox) => sandbox.workspaceId === workspaceId && sandbox.status !== 'destroyed'
  )
  const results = await Promise.all(live.map((sandbox) => deleted(client, sandbox.id, log)))
  return results.every(Boolean)
}
