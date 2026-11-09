// "Orca Cloud" as a built-in per-workspace environment: listed first wherever recipes are, run
// in-process through the HostedSandboxDriver, and answering like a recipe process would.
import { z } from 'zod'
import { EphemeralVmRecipeResultSchema } from '../../shared/ephemeral-vm-recipes'
import { ephemeralVmFailure } from '../../shared/ephemeral-vm-failure-copy'
import { normalizeGitRemoteUrl } from '../../shared/git/remotes/git-remote-identity'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import {
  registerEphemeralVmRecipeStepProvider,
  type RecipeStepProvider,
  type RecipeStepProviderResult
} from '../../shared/ephemeral-vm-recipe-step-providers'
import { getRemoteUrl } from '../git/repo'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import {
  isHostedEntitlementDenied,
  type HostedEnvironmentProviderDriver,
  type HostedEnvironmentReady
} from './hosted-environment-provider'
import { createHostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { createHostedSandboxDriver, HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'
import type { HostedSandboxConfig } from './hosted-sandbox-config'

import { ORCA_CLOUD_RECIPE_ID } from '../../shared/hosted-sandbox/orca-cloud-recipe-id'

export { ORCA_CLOUD_RECIPE_ID }

export const ORCA_CLOUD_RECIPE: OrcaVmRecipe = {
  id: ORCA_CLOUD_RECIPE_ID,
  name: 'Orca Cloud',
  description: 'Hosted by Orca. Sleeps when idle and keeps your files.',
  provider: 'orca-cloud',
  create: 'orca-cloud create',
  suspend: 'orca-cloud suspend',
  resume: 'orca-cloud resume',
  destroy: 'orca-cloud destroy',
  timeoutSeconds: { create: 300, resume: 180, suspend: 420, destroy: 120 }
}

const LifecyclePayload = z.looseObject({ recipeResult: EphemeralVmRecipeResultSchema.optional() })

export function createHostedSandboxRecipeClient(config: HostedSandboxConfig) {
  return createHostedSandboxControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    getAccessToken: config.getAccessToken
  })
}

export function createHostedSandboxRecipeDriver(
  config: HostedSandboxConfig,
  client = createHostedSandboxRecipeClient(config)
): HostedEnvironmentProviderDriver {
  return createHostedSandboxDriver(client)
}

/** https clone URL the control plane can mint a GitHub App token for; null for non-GitHub remotes. */
export async function hostedSandboxRepoUrl(repoPath: string): Promise<string | null> {
  const remote = await getRemoteUrl(repoPath)
  const normalized = remote ? normalizeGitRemoteUrl(remote) : null
  return normalized?.startsWith('github.com/') ? `https://${normalized}.git` : null
}

function ok(stdout: string): RecipeStepProviderResult {
  return { stdout, stderr: '', exitCode: 0, signal: null }
}

function failed(error: unknown): RecipeStepProviderResult {
  const base = { stdout: '', exitCode: 1, signal: null }
  if (
    isHostedEntitlementDenied(error) &&
    (error.reason === 'concurrency_limit' || error.reason === 'member_concurrency_limit')
  ) {
    return {
      ...base,
      stderr: `Orca Cloud: ${error.reason}\n`,
      failure: ephemeralVmFailure('cloudConcurrencyLimit')
    }
  }
  if (isHostedEntitlementDenied(error)) {
    return {
      ...base,
      stderr: `Orca Cloud: ${error.reason ?? 'no plan'}\n`,
      failure: ephemeralVmFailure('cloudPlanRequired')
    }
  }
  if (isEnvironmentProviderError(error, 'conflict') && error.reason === 'github_not_connected') {
    return {
      ...base,
      stderr: `Orca Cloud: ${error.reason}\n`,
      failure: ephemeralVmFailure('cloudGithubNotConnected')
    }
  }
  if (isEnvironmentProviderError(error, 'unauthorized')) {
    return { ...base, stderr: '', failure: ephemeralVmFailure('cloudSignInRequired') }
  }
  if (
    isEnvironmentProviderError(error, 'unavailable') ||
    isEnvironmentProviderError(error, 'timeout')
  ) {
    return {
      ...base,
      stderr: `${error.message}\n`,
      failure: ephemeralVmFailure('cloudUnavailable')
    }
  }
  return { ...base, stderr: `${error instanceof Error ? error.message : String(error)}\n` }
}

export function createHostedSandboxStepProvider(
  driver: HostedEnvironmentProviderDriver,
  hooks: {
    onReady?: (ready: HostedEnvironmentReady) => void
    onStopped?: (environmentId: string) => void
    /** Wake progress for the window's "Waking…" overlay (resume only). */
    onWake?: (event: {
      workspaceId: string
      phase: 'waking' | 'connecting' | 'ready' | 'failed'
      startedAt: number
      message?: string
    }) => void
  } = {}
): RecipeStepProvider {
  return async ({ mode, repoPath, context, stdin, signal, onStderr }) => {
    const ctx = {
      signal,
      onProgress: ({ phase }: { phase: string }) => onStderr?.(`[orca-cloud] ${phase}\n`)
    }
    try {
      if (mode === 'create') {
        const repoUrl = await hostedSandboxRepoUrl(repoPath)
        const ready = await driver.create(
          {
            // One create attempt = one sandbox: a retried attempt reuses the instance id.
            workspaceId: context.instanceId ?? context.workspaceId ?? 'workspace',
            machineSize: 'standard',
            ...(repoUrl
              ? { repo: { url: repoUrl, ...(context.branch ? { ref: context.branch } : {}) } }
              : {})
          },
          ctx
        )
        hooks.onReady?.(ready)
        return ok(JSON.stringify(ready.result))
      }
      const payload = LifecyclePayload.parse(JSON.parse(stdin ?? '{}'))
      const handle = payload.recipeResult
        ? environmentHandleFromRecipeResult(payload.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
        : null
      if (!handle) {
        return { stdout: '', stderr: 'Not an Orca Cloud environment.\n', exitCode: 1, signal: null }
      }
      if (mode === 'resume') {
        const workspaceId = context.workspaceId
        const startedAt = Date.now()
        if (workspaceId) {
          hooks.onWake?.({ workspaceId, phase: 'waking', startedAt })
        }
        try {
          const ready = await driver.resume(handle, ctx)
          if (workspaceId) {
            hooks.onWake?.({ workspaceId, phase: 'connecting', startedAt })
          }
          hooks.onReady?.(ready)
          return ok(JSON.stringify(ready.result))
        } catch (error) {
          if (workspaceId) {
            hooks.onWake?.({
              workspaceId,
              phase: 'failed',
              startedAt,
              message: error instanceof Error ? error.message : String(error)
            })
          }
          throw error
        }
      }
      await (mode === 'suspend' ? driver.suspend(handle, ctx) : driver.destroy(handle, ctx))
      hooks.onStopped?.(handle.environmentId)
      return ok('')
    } catch (error) {
      const result = failed(error)
      // Only streamed stderr reaches the build log, so the control plane's reason must be streamed too.
      if (result.stderr) {
        onStderr?.(result.stderr)
      }
      return result
    }
  }
}

export function registerHostedSandboxRecipe(
  driver: HostedEnvironmentProviderDriver,
  hooks: Parameters<typeof createHostedSandboxStepProvider>[1] = {}
): () => void {
  return registerEphemeralVmRecipeStepProvider(
    'orca-cloud',
    createHostedSandboxStepProvider(driver, hooks)
  )
}
