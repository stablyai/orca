import type { AgentHookInstallStatus } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { dedupeInFlightRun } from '../../../runtime/concurrency/in-flight-run-dedupe'
import { getManagedScriptPath } from '../definitions/codex-hook-definition'
import { buildCodexHookCommand as getManagedCommand } from '../definitions/codex-hook-command-form'
import { installCodexHooksExclusively } from './codex-hook-local-install'
import {
  getManagedCodexHookHome,
  readStopgapOrcaHashes
} from '../../trust/hooks/codex-hook-orca-approvals'
import { refreshCodexRuntimeUserHooksExclusively } from './codex-hook-local-maintenance'
import { readCodexHookHomeStatus } from '../reconciliation/codex-hook-status'
import {
  CODEX_ANSWER_AWAITED,
  CODEX_HOOK_LAUNCH_WAIT_MS,
  readKnownCodexHookAnswer,
  resolveCodexHookAnswerForLaunch
} from '../../trust/hooks/codex-hook-hash-lookup'
import { runExclusivelyForRuntimeAndSystemTrustConfig } from '../../trust/hooks/codex-hook-trust-queue'
import { withFileContentObservation } from '../../../filesystem/file-content-observation'
import { readCodexLaunchPreparationInputs } from './codex-launch-preparation-inputs'

// Separate hooks-on/off and Codex/terminal runs: their trust outcomes and wait budgets differ.
function launchPrepKey(
  lane: 'install' | 'codex-launch' | 'refresh',
  runtimeHomePath: string
): string {
  return `${lane}\0${normalizeRuntimePathForComparison(runtimeHomePath)}`
}

export class CodexHookLaunchPreparation {
  private readonly launchPrepInFlight = new Map<string, Promise<AgentHookInstallStatus>>()
  private readonly completedLaunchPrep = new Map<
    string,
    { digest: string; status: AgentHookInstallStatus }
  >()
  clear(): void {
    this.completedLaunchPrep.clear()
  }
  install(
    runtimeHomePath: string,
    launchesCodex: boolean,
    isHooksEnabled: () => boolean
  ): Promise<AgentHookInstallStatus> {
    this.clear()
    return this.prepareLocalInstall(runtimeHomePath, launchesCodex, isHooksEnabled)
  }
  private async prepareLocalInstall(
    runtimeHomePath: string,
    launchesCodex: boolean,
    isHooksEnabled: () => boolean,
    reuseKey?: string
  ): Promise<AgentHookInstallStatus> {
    const answer =
      (await resolveCodexHookAnswerForLaunch(launchesCodex ? CODEX_HOOK_LAUNCH_WAIT_MS : 0)) ??
      CODEX_ANSWER_AWAITED
    return runExclusivelyForRuntimeAndSystemTrustConfig(runtimeHomePath, () => {
      // Recheck in the queue so an Off that landed during hash lookup wins.
      const enabled = isHooksEnabled()
      const run = (onComplete?: () => void): Promise<AgentHookInstallStatus> => {
        if (!enabled || answer.kind === 'refused') {
          return refreshCodexRuntimeUserHooksExclusively(
            runtimeHomePath,
            (homePath) => readCodexHookHomeStatus(homePath, answer),
            onComplete
          )
        }
        // Pending answers still consult the complete stopgap memo/ledger on every preparation.
        const hashes =
          answer.kind === 'hashes'
            ? answer.hashes
            : readStopgapOrcaHashes(
                getManagedCodexHookHome(runtimeHomePath),
                getManagedCommand(getManagedScriptPath())
              )
        return installCodexHooksExclusively(
          runtimeHomePath,
          hashes,
          (homePath) => readCodexHookHomeStatus(homePath, answer),
          onComplete
        )
      }
      if (!reuseKey) {
        return run()
      }
      if (answer.kind !== 'hashes') {
        this.completedLaunchPrep.delete(reuseKey)
        return run()
      }
      return this.reuseCompletedPreparation(
        reuseKey,
        runtimeHomePath,
        JSON.stringify([enabled, answer]),
        run
      )
    })
  }

  // Reuse only a complete pass whose actual observations and fresh inputs still agree.
  installForLaunchPrep(
    runtimeHomePath: string,
    launchesCodex: boolean,
    isHooksEnabled: () => boolean
  ): Promise<AgentHookInstallStatus> {
    const homePath = runtimeHomePath
    return dedupeInFlightRun(
      this.launchPrepInFlight,
      launchPrepKey(launchesCodex ? 'codex-launch' : 'install', homePath),
      () =>
        this.prepareLocalInstall(
          homePath,
          launchesCodex,
          isHooksEnabled,
          launchPrepKey(launchesCodex ? 'codex-launch' : 'install', homePath)
        )
    )
  }

  refreshRuntimeUserHooksForLaunchPrep(
    runtimeHomePath: string,
    getStatus: (home: string) => AgentHookInstallStatus
  ): Promise<AgentHookInstallStatus> {
    const homePath = runtimeHomePath
    return dedupeInFlightRun(this.launchPrepInFlight, launchPrepKey('refresh', homePath), () =>
      runExclusivelyForRuntimeAndSystemTrustConfig(homePath, () => {
        const answer = readKnownCodexHookAnswer()
        if (answer?.kind !== 'hashes') {
          this.completedLaunchPrep.delete(launchPrepKey('refresh', homePath))
          return refreshCodexRuntimeUserHooksExclusively(homePath, getStatus)
        }
        const answerKey = JSON.stringify(answer)
        return this.reuseCompletedPreparation(
          launchPrepKey('refresh', homePath),
          homePath,
          answerKey,
          async (onComplete) => {
            let complete = false
            const status = await refreshCodexRuntimeUserHooksExclusively(
              homePath,
              getStatus,
              () => {
                complete = true
              }
            )
            if (complete && JSON.stringify(readKnownCodexHookAnswer()) === answerKey) {
              onComplete?.()
            }
            return status
          }
        )
      })
    )
  }

  private async reuseCompletedPreparation(
    key: string,
    homePath: string,
    context: string,
    run: (onComplete?: () => void) => Promise<AgentHookInstallStatus>
  ): Promise<AgentHookInstallStatus> {
    const before = readCodexLaunchPreparationInputs(homePath)
    const digest = before ? `${context}\0${before.digest}` : null
    const previous = this.completedLaunchPrep.get(key)
    if (digest !== null && previous?.digest === digest) {
      return { ...previous.status }
    }
    this.completedLaunchPrep.delete(key)
    if (!before) {
      return run()
    }
    let complete = false
    const result = await withFileContentObservation(
      before.files,
      before.paths,
      async (isStillValid) => {
        const status = await run(() => {
          complete = true
        })
        // This read also validates the last exact publications against the observation scope.
        const stable =
          complete &&
          isStillValid() &&
          readCodexLaunchPreparationInputs(homePath, isStillValid)?.digest === before.digest
        return { status, stable }
      }
    )
    if (complete && result.matches && result.value.stable && digest !== null) {
      this.completedLaunchPrep.set(key, { digest, status: { ...result.value.status } })
      if (this.completedLaunchPrep.size > 32) {
        this.completedLaunchPrep.delete(this.completedLaunchPrep.keys().next().value!)
      }
    }
    return result.value.status
  }
}
