// A create cancelled while its request was in flight may still have made a sandbox on the control
// plane, and a sandbox bills (GH-CREATE-CANCEL). The control plane keys creates by Idempotency-Key
// and body: sending the same create again hands back the sandbox the first one made (or makes one, if
// the first never arrived), and that sandbox is deleted. Shared by the owned create (the recipe) and
// the GitHub-only create, which both go through createSandboxWithProgress.
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'

type CreateBody = Parameters<HostedSandboxControlPlaneClient['create']>[0]

const RECLAIM_ATTEMPTS = 8
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
  client: Pick<HostedSandboxControlPlaneClient, 'create' | 'destroy'>,
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
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      continue
    }
    try {
      await client.destroy(sandboxId)
      log(`[orca-cloud] cancelled create: deleted sandbox ${sandboxId}`)
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
  log('[orca-cloud] cancelled create: could not confirm the sandbox was deleted')
  return false
}
