// "Start in Orca Cloud" for a GitHub repository with no clone here (cloud-start D4), with the same
// build sheet as an owned create (GH-CREATE-SHEET): the same progress lines (boot plan, start,
// clone or update with git's percent) and the same failure lines and codes, so the window's sheet
// reads both alike.
import { createHash, randomBytes } from 'node:crypto'
import type {
  CloudWorkspaceErrorCode,
  CloudWorkspaceResult
} from '../../shared/hosted-sandbox/cloud-workspace-api'
import {
  EnvironmentProviderError,
  type EnvironmentCreateSpec
} from '../environment-providers/environment-provider-driver'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { reclaimCancelledCreate } from './hosted-sandbox-create-reclaim'
import {
  CANCEL_CLEANUP_UNCONFIRMED,
  createSandboxWithProgress,
  hostedCreateBody
} from './hosted-sandbox-driver'
import { hostedCreateFailure, hostedProgressLine } from './hosted-sandbox-recipe'

/** The server's Idempotency-Key format. */
export const CLOUD_CREATE_IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/
/** A creation id from the window: the build sheet's log and its Cancel are keyed by it. */
export const CLOUD_CREATE_PROVISION_ID = /^[A-Za-z0-9_.:-]{1,128}$/

export type CreateFromGitHubInput = {
  /** `owner/repo`. */
  slug: string
  /** The name typed in the composer; empty for none. */
  title: string
  provisionId: string | null
  idempotencyKey: string | null
}

export type CreateFromGitHubClient = Pick<
  HostedSandboxControlPlaneClient,
  'create' | 'bootPlan' | 'cloneStatus' | 'destroy' | 'list'
>

/**
 * The workspace id: `<repo>-<hex>`, like the phone's. Fixed per creation so a Retry sends the same
 * body as the first attempt; the server replays an Idempotency-Key only for the same body.
 */
export function githubWorkspaceId(slug: string, provisionId: string | null): string {
  const name = (slug.split('/').pop() ?? 'workspace').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 48)
  const suffix = provisionId
    ? createHash('sha256').update(provisionId).digest('hex').slice(0, 8)
    : randomBytes(4).toString('hex')
  return `${name}-${suffix}`
}

const CODE_BY_FAILURE: Partial<Record<string, CloudWorkspaceErrorCode>> = {
  cloudSignInRequired: 'unauthorized',
  cloudPlanRequired: 'entitlement_denied',
  cloudConcurrencyLimit: 'entitlement_denied',
  cloudUnavailable: 'unavailable'
}

/**
 * Starts the sandbox and waits for its clone, reporting each step through `onLog`. A failure comes
 * back with the failure code as `reason` (e.g. `cloudPlanRequired`) after its reason line was logged.
 */
function createSpec(input: CreateFromGitHubInput): EnvironmentCreateSpec {
  return {
    workspaceId: githubWorkspaceId(input.slug, input.provisionId),
    machineSize: 'standard',
    repo: { url: `https://github.com/${input.slug}.git` },
    ...(input.title ? { workspaceName: input.title } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
  }
}

/** EP-5: cancelled creates whose sandbox wasn't confirmed deleted, by creation id, for Try again. */
const unconfirmedCancels = new Map<string, CreateFromGitHubInput>()

/**
 * Try again for a cancelled create the first cleanup couldn't confirm: replays it by its key (or
 * finds it by its workspace id) and deletes it. True once deleted, or when there is nothing to do.
 */
export async function retryCancelledGitHubCreate(
  client: Pick<CreateFromGitHubClient, 'create' | 'destroy' | 'list'>,
  provisionId: string,
  options: Parameters<typeof reclaimCancelledCreate>[3] = {}
): Promise<boolean> {
  const input = unconfirmedCancels.get(provisionId)
  if (!input?.idempotencyKey) {
    return true
  }
  const spec = createSpec(input)
  const ok = await reclaimCancelledCreate(
    client,
    hostedCreateBody(spec),
    input.idempotencyKey,
    options
  )
  if (ok) {
    unconfirmedCancels.delete(provisionId)
  }
  return ok
}

export async function createCloudWorkspaceFromGitHub(
  client: CreateFromGitHubClient,
  input: CreateFromGitHubInput,
  io: { signal?: AbortSignal; onLog?: (chunk: string) => void } = {}
): Promise<CloudWorkspaceResult<{ sandboxId: string }>> {
  try {
    const ready = await createSandboxWithProgress(client, createSpec(input), {
      ...(io.signal ? { signal: io.signal } : {}),
      onProgress: (progress) => io.onLog?.(hostedProgressLine(progress))
    })
    return { ok: true, value: { sandboxId: ready.sandbox.id } }
  } catch (error) {
    if (error instanceof EnvironmentProviderError && error.reason === CANCEL_CLEANUP_UNCONFIRMED) {
      // The window must not say "Sandbox deleted" for this one; Try again retries the delete.
      if (input.provisionId) {
        unconfirmedCancels.set(input.provisionId, input)
      }
      return {
        ok: false,
        code: 'failed',
        message: 'Cancelled.',
        reason: CANCEL_CLEANUP_UNCONFIRMED
      }
    }
    const result = hostedCreateFailure(error)
    if (result.stderr) {
      io.onLog?.(result.stderr)
    }
    const errorCode = result.failure?.errorCode ?? null
    return {
      ok: false,
      code: (errorCode ? CODE_BY_FAILURE[errorCode] : undefined) ?? 'failed',
      message:
        result.failure?.error ??
        (result.stderr.trim() || (error instanceof Error ? error.message : String(error))),
      reason: errorCode
    }
  }
}
