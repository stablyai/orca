import type { AgentHookInstallStatus } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import {
  adoptFileObservation,
  captureFileObservation
} from '../../../filesystem/file-content-observation'
import { runCodexHookPassOnTrustWorker } from '../../trust/project-trust/codex-project-trust-worker-client'
import { cleanupLegacyManagedHookRepresentations } from '../reconciliation/codex-hook-legacy-cleanup'
import { getConfigPath } from '../definitions/codex-hook-definition'
import type { CodexHookPassEffects } from './codex-hook-install-effects'
import type { CodexLaunchConfigPreparation } from './codex-hook-launch-preparation'
import type { CodexHookPassRequest } from './codex-hook-pass-worker'
import { stripCodexManagedHookEffects } from './codex-hook-managed-strip'

/**
 * Runs a hook pass's file effects on the Codex project trust worker. The caller holds the
 * runtime-before-system lanes until this resolves, which is after the worker has exited when it fails.
 */
export async function runCodexHookPassEffectsOffMain(
  request: CodexHookPassRequest,
  configPreparation?: CodexLaunchConfigPreparation
): Promise<CodexHookPassEffects> {
  const configMirror = configPreparation?.pendingMirror() ?? null
  const observation = captureFileObservation()
  let result: Awaited<ReturnType<typeof runCodexHookPassOnTrustWorker>>
  try {
    result = await runCodexHookPassOnTrustWorker({ ...request, configMirror, observation })
  } catch (error) {
    adoptFileObservation({ matches: false, files: [] })
    if (request.mode === 'strip') {
      // Why: Off stays authoritative even with the worker down. Strip only: the user-hook rebuild stays
      // on the worker, so approvals may sit in shifted slots until the next launch's refresh.
      return stripCodexManagedHookEffects(request.runtimeHomePath, request.codexHashes)
    }
    if (configMirror) {
      // Why: Codex still needs its mirrored config; the hook pass itself is never rerun on main.
      configPreparation?.run()
    }
    return { kind: 'status', status: hookPassUnavailable(request.runtimeHomePath, error) }
  }
  adoptFileObservation(result.observation ?? { matches: false, files: [] })
  if (result.config) {
    configPreparation?.settle(result.config)
  }
  // Settled above, so this only returns the mirror's result or rethrows its error.
  const configComplete = configPreparation?.run() ?? true
  if (result.effectsError) {
    throw result.effectsError
  }
  const effects = result.effects
  if (!effects) {
    return {
      kind: 'status',
      status: hookPassUnavailable(request.runtimeHomePath, 'no result')
    }
  }
  return effects.kind === 'written'
    ? { kind: 'written', complete: effects.complete && configComplete }
    : effects
}

/** The main-thread end of a pass: legacy cleanup, then status, inside the caller's lanes and observation. */
export async function finishCodexHookPass(
  runtimeHomePath: string,
  effects: CodexHookPassEffects,
  getStatus: (runtimeHomePath: string) => AgentHookInstallStatus,
  onComplete?: () => void
): Promise<AgentHookInstallStatus> {
  if (effects.kind === 'status') {
    if (effects.cleanupFirst) {
      await cleanupLegacyManagedHookRepresentations()
    }
    return effects.status
  }
  const cleaned = await cleanupLegacyManagedHookRepresentations()
  const status = getStatus(runtimeHomePath)
  if (effects.complete && cleaned && status.state !== 'error') {
    onComplete?.()
  }
  return status
}

function hookPassUnavailable(runtimeHomePath: string, error: unknown): AgentHookInstallStatus {
  return {
    agent: 'codex',
    state: 'error',
    configPath: getConfigPath(runtimeHomePath),
    managedHooksPresent: false,
    detail: `Codex hooks could not be written: ${error instanceof Error ? error.message : String(error)}`
  }
}
