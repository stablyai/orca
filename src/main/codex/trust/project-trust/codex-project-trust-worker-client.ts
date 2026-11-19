import { join } from 'node:path'
import { WorkerThreadRequestQueue } from '../../../worker-threads/worker-thread-request-queue'
import { getOrcaUserDataPath } from '../../configuration/homes/codex-home-paths'
import { runExclusivelyForCodexTrustConfig } from '../toml/codex-trust-config-mutation-queue'
import { spawnCodexProjectTrustWorker } from './codex-project-trust-worker-spawn'
import type {
  CodexHookPassWorkerRequest,
  CodexHookPassWorkerResult
} from '../../hooks/installation/codex-hook-pass-worker'
import type { CodexHookPassEffects } from '../../hooks/installation/codex-hook-install-effects'
import type { ObservedFileContent } from '../../../filesystem/file-content-observation'
import type {
  CodexProjectTrustWorkerFailure,
  CodexProjectTrustWorkerRequest,
  CodexProjectTrustWorkerResponse
} from './codex-project-trust-worker-protocol'

const LEDGER_FILE_NAME = 'codex-project-trust-created.json'
// Catches a stuck worker only; the 20 s launch deadline already lets launch continue without waiting.
const REQUEST_TIMEOUT_MS = 60_000
// Grants come in launch bursts; an idle worker is released.
const IDLE_TEARDOWN_MS = 60_000

let queue: WorkerThreadRequestQueue<
  CodexProjectTrustWorkerRequest,
  CodexProjectTrustWorkerResponse
> | null = null

function getQueue(): NonNullable<typeof queue> {
  queue ??= new WorkerThreadRequestQueue({
    factory: spawnCodexProjectTrustWorker,
    idleTeardownMs: IDLE_TEARDOWN_MS,
    maxConsecutiveDeaths: 2,
    // A timed-out worker can still be mid-write; never start a second ledger writer beside it.
    awaitRetirement: true,
    createUnavailableError: (message) =>
      new Error(`Codex project trust worker unavailable: ${message}`),
    describeTimeout: (ms) => `Codex project trust worker timed out after ${ms}ms`,
    describeExit: (code) => `Codex project trust worker exited with code ${code}`,
    describeCrashLoop: (error) => `Codex project trust worker crashed repeatedly: ${error}`,
    onUnavailable: (error) =>
      console.warn('[codex-config] Project trust worker unavailable:', error)
  })
  return queue
}

function toError(failure: CodexProjectTrustWorkerFailure): Error {
  const error: Error & { code?: string } = new Error(failure.message)
  error.name = failure.name
  if (failure.code) {
    error.code = failure.code
  }
  return error
}

async function request(
  build: (id: number, ledgerPath: string) => CodexProjectTrustWorkerRequest
): Promise<Extract<CodexProjectTrustWorkerResponse, { ok: true }>> {
  const ledgerPath = join(getOrcaUserDataPath(), LEDGER_FILE_NAME)
  const active = getQueue()
  let response: CodexProjectTrustWorkerResponse
  try {
    response = await active.dispatch((id) => build(id, ledgerPath), REQUEST_TIMEOUT_MS)
  } catch (error) {
    // Why: a stopped worker may still finish a rename; callers hold config locks until it has exited.
    await active.retired().catch(() => {})
    throw error
  }
  if (!response.ok) {
    throw toError(response.error)
  }
  return response
}

export type CodexHookPassOutcome = {
  config?: { value: boolean } | { error: Error }
  effects?: CodexHookPassEffects
  effectsError?: Error
  observation?: { matches: boolean; files: ObservedFileContent[] }
}

/**
 * Runs a hook pass's file effects on the same queue as trust grants, so they never overlap.
 * Call with the runtime-before-system lanes held; rejects only after a failed worker has exited.
 */
export async function runCodexHookPassOnTrustWorker(
  pass: CodexHookPassWorkerRequest
): Promise<CodexHookPassOutcome> {
  const response = await request((id) => ({ id, kind: 'hookPass', ...pass }))
  const result: CodexHookPassWorkerResult = response.hookPass ?? {}
  return {
    effects: result.effects,
    observation: result.observation,
    ...(result.effectsError ? { effectsError: toError(result.effectsError) } : {}),
    ...(result.config
      ? {
          config: 'error' in result.config ? { error: toError(result.config.error) } : result.config
        }
      : {})
  }
}

/** Call with every config's mutation lock held, in hook-installer order. */
export async function grantCodexProjectTrustOffMain(
  configFiles: readonly string[],
  workspacePath: string
): Promise<void> {
  await request((id, ledgerPath) => ({
    id,
    kind: 'grant',
    configFiles: [...configFiles],
    workspacePath,
    ledgerPath
  }))
}

/**
 * Removes every Orca-created project trust entry for `projectPath`, wherever
 * recorded. Never throws: removal rides the worktree-removal path, which must
 * not fail over a config file it cannot read — the record is kept so a later
 * pass retries. Resolves once every touched file has been written.
 */
export async function removeOrcaCreatedProjectTrustEntries(projectPath: string): Promise<void> {
  let configFiles: string[]
  try {
    const listed = await request((id, ledgerPath) => ({
      id,
      kind: 'listOwnedConfigs',
      projectPath,
      ledgerPath
    }))
    configFiles = listed.configFiles ?? []
  } catch (error) {
    console.warn('[codex-config] Failed to read Orca-created project trust ownership:', error)
    return
  }
  // Why: one lock at a time; nesting in ledger order could deadlock against installer order.
  for (const configPath of configFiles) {
    await runExclusivelyForCodexTrustConfig(configPath, async () => {
      try {
        await request((id, ledgerPath) => ({
          id,
          kind: 'removeOwned',
          configPath,
          projectPath,
          ledgerPath
        }))
      } catch (error) {
        console.warn('[codex-config] Failed to remove an Orca-created project trust entry:', error)
      }
    })
  }
}
