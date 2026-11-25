import { join } from 'node:path'
import { withHookPassEditGuard } from './codex-hook-pass-edit-guard'
import {
  withCapturedFileObservation,
  type CapturedFileObservation,
  type ObservedFileContent
} from '../../../filesystem/file-content-observation'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { getCodexSettingsBaselinePath } from '../../configuration/settings/config-settings-baseline'
import type { CodexSettingsPromotionHomes } from '../../configuration/settings/config-settings-promotion'
import { syncSystemConfigIntoManagedCodexHome } from '../../configuration/settings/codex-config-mirror'
import type { CodexHookHashes } from '../../trust/hooks/codex-hook-trust-derivation'
import { getProvenancePath } from '../../trust/hooks/hook-trust-promotion'
import { getConfigPath } from '../definitions/codex-hook-definition'
import {
  writeCodexHookInstallEffects,
  type CodexHookPassEffects
} from './codex-hook-install-effects'
import { writeCodexRuntimeUserHookRefreshEffects } from './codex-hook-refresh-effects'
import { writeCodexOffStripEffects } from './codex-hook-off-strip'

export type CodexHookPassRequest =
  | { mode: 'install'; runtimeHomePath: string; hashes: CodexHookHashes }
  | { mode: 'refresh'; runtimeHomePath: string }
  | { mode: 'strip'; runtimeHomePath: string; codexHashes: CodexHookHashes[] }
  /** Recovery after a worker death: only the owed config mirror; the hook pass is never replayed. */
  | { mode: 'mirror'; runtimeHomePath: string }

export type CodexHookPassWorkerRequest = CodexHookPassRequest & {
  /** The launch's owed config mirror, run first as the main thread used to. */
  configMirror: CodexSettingsPromotionHomes | null
  /** The caller's open observation scope, continued here; null when it has none. */
  observation: CapturedFileObservation | null
}

export type TransportedError = { name: string; message: string; code?: string }

export type CodexHookPassWorkerResult = {
  config?: { value: boolean } | { error: TransportedError }
  effects?: CodexHookPassEffects
  effectsError?: TransportedError
  observation?: { matches: boolean; files: ObservedFileContent[] }
}

// Another writer racing the same pass is rare; a few redos settle it without starving the launch.
const PASS_ATTEMPTS = 3

export function toTransportedError(error: unknown): TransportedError {
  const value = error instanceof Error ? error : new Error(String(error))
  const code = 'code' in value && typeof value.code === 'string' ? value.code : undefined
  return { name: value.name, message: value.message, ...(code ? { code } : {}) }
}

function guardedPaths(request: CodexHookPassWorkerRequest): string[] {
  const homes = new Set([request.runtimeHomePath, getSystemCodexHomePath()])
  if (request.configMirror) {
    homes.add(request.configMirror.runtimeHomePath)
    homes.add(request.configMirror.systemHomePath)
  }
  const paths: string[] = []
  for (const home of homes) {
    paths.push(join(home, 'config.toml'), getConfigPath(home))
  }
  return [
    ...paths,
    getCodexSettingsBaselinePath(request.runtimeHomePath),
    getProvenancePath(request.runtimeHomePath)
  ]
}

function runOnce(request: CodexHookPassWorkerRequest): CodexHookPassWorkerResult {
  let config: CodexHookPassWorkerResult['config']
  if (request.configMirror) {
    try {
      config = { value: syncSystemConfigIntoManagedCodexHome(request.configMirror) }
    } catch (error) {
      // Config errors fail the launch, as when main mirrored before the pass.
      return { config: { error: toTransportedError(error) } }
    }
  }
  try {
    return { config, effects: writeEffects(request) }
  } catch (error) {
    return { config, effectsError: toTransportedError(error) }
  }
}

function writeEffects(request: CodexHookPassWorkerRequest): CodexHookPassEffects {
  switch (request.mode) {
    case 'install':
      return writeCodexHookInstallEffects(request.runtimeHomePath, request.hashes)
    case 'refresh':
      return writeCodexRuntimeUserHookRefreshEffects(request.runtimeHomePath)
    case 'strip':
      return writeCodexOffStripEffects(request.runtimeHomePath, request.codexHashes)
    case 'mirror':
      return { kind: 'written', complete: false }
  }
}

/** Redoes the whole pass when another writer changed a file it was editing; never publishes over it. */
function runGuarded(request: CodexHookPassWorkerRequest): CodexHookPassWorkerResult {
  const paths = guardedPaths(request)
  let conflict: string | null = null
  let last: CodexHookPassWorkerResult = {}
  for (let attempt = 0; attempt < PASS_ATTEMPTS; attempt++) {
    const guarded = withHookPassEditGuard(paths, () => runOnce(request))
    last = guarded.value
    conflict = guarded.conflict
    if (conflict === null) {
      return last
    }
  }
  return {
    // A mirror stopped by the conflict is left owed, so main runs it once rather than failing the launch.
    config: last.config && 'value' in last.config ? last.config : undefined,
    effects: {
      kind: 'status',
      status: {
        agent: 'codex',
        state: 'error',
        configPath: getConfigPath(request.runtimeHomePath),
        // A stripped pass published nothing, so Orca's hooks may still be there until the next pass.
        managedHooksPresent: request.mode === 'strip',
        detail: `Codex hooks could not be ${request.mode === 'strip' ? 'removed' : 'written'}: ${conflict} kept changing`
      }
    }
  }
}

export async function runCodexHookPassRequest(
  request: CodexHookPassWorkerRequest
): Promise<CodexHookPassWorkerResult> {
  if (!request.observation) {
    return runGuarded(request)
  }
  const observed = await withCapturedFileObservation(request.observation, () => runGuarded(request))
  return {
    ...observed.value,
    observation: { matches: observed.matches, files: observed.files }
  }
}
