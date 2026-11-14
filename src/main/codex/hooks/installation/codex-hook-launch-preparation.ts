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
import type { CodexHookAnswer } from '../../trust/hooks/codex-hook-trust-derivation'

export type CodexLaunchConfigPreparation = {
  run: () => boolean
  complete: () => void
}

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
    reuseKey?: string,
    configPreparation?: CodexLaunchConfigPreparation,
    resolvedAnswer?: CodexHookAnswer
  ): Promise<AgentHookInstallStatus> {
    let answer =
      resolvedAnswer ??
      (await resolveCodexHookAnswerForLaunch(launchesCodex ? CODEX_HOOK_LAUNCH_WAIT_MS : 0)) ??
      CODEX_ANSWER_AWAITED
    if (configPreparation && answer.kind !== 'hashes') {
      if (reuseKey) {
        this.completedLaunchPrep.delete(reuseKey)
      }
      configPreparation.run()
      return dedupeInFlightRun(
        this.launchPrepInFlight,
        launchPrepKey(launchesCodex ? 'codex-launch' : 'install', runtimeHomePath),
        () =>
          this.prepareLocalInstall(
            runtimeHomePath,
            launchesCodex,
            isHooksEnabled,
            undefined,
            undefined,
            answer
          )
      )
    }
    return runExclusivelyForRuntimeAndSystemTrustConfig(runtimeHomePath, () => {
      // Recheck in the queue so an Off that landed during hash lookup wins.
      let enabled = isHooksEnabled()
      const run = (onComplete?: () => void): Promise<AgentHookInstallStatus> => {
        const configComplete = configPreparation?.run() ?? true
        const completed = configComplete ? onComplete : undefined
        if (!enabled || answer.kind === 'refused') {
          return refreshCodexRuntimeUserHooksExclusively(
            runtimeHomePath,
            (homePath) => readCodexHookHomeStatus(homePath, answer),
            completed
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
          completed
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
        () => {
          enabled = isHooksEnabled()
          answer = readKnownCodexHookAnswer() ?? CODEX_ANSWER_AWAITED
          return answer.kind === 'hashes' ? JSON.stringify([enabled, answer]) : null
        },
        run
      )
    })
  }

  // Reuse only a complete pass whose actual observations and fresh inputs still agree.
  async installForLaunchPrep(
    runtimeHomePath: string,
    launchesCodex: boolean,
    isHooksEnabled: () => boolean,
    configPreparation?: CodexLaunchConfigPreparation
  ): Promise<AgentHookInstallStatus> {
    const homePath = runtimeHomePath
    const key = launchPrepKey(launchesCodex ? 'codex-launch' : 'install', homePath)
    const run = (): Promise<AgentHookInstallStatus> =>
      this.prepareLocalInstall(
        homePath,
        launchesCodex,
        isHooksEnabled,
        configPreparation ? `${key}\0config` : key,
        configPreparation
      )
    const status = await (configPreparation
      ? run()
      : dedupeInFlightRun(this.launchPrepInFlight, key, run))
    configPreparation?.complete()
    return status
  }

  async refreshRuntimeUserHooksForLaunchPrep(
    runtimeHomePath: string,
    getStatus: (home: string) => AgentHookInstallStatus,
    configPreparation?: CodexLaunchConfigPreparation
  ): Promise<AgentHookInstallStatus> {
    const homePath = runtimeHomePath
    const key = `${launchPrepKey('refresh', homePath)}${configPreparation ? '\0config' : ''}`
    if (configPreparation && readKnownCodexHookAnswer()?.kind !== 'hashes') {
      this.completedLaunchPrep.delete(key)
      configPreparation.run()
      const status = await this.refreshRuntimeUserHooksForLaunchPrep(homePath, getStatus)
      configPreparation.complete()
      return status
    }
    const run = (): Promise<AgentHookInstallStatus> =>
      runExclusivelyForRuntimeAndSystemTrustConfig(homePath, () => {
        const refresh = (onComplete?: () => void): Promise<AgentHookInstallStatus> => {
          const configComplete = configPreparation?.run() ?? true
          return refreshCodexRuntimeUserHooksExclusively(
            homePath,
            getStatus,
            configComplete ? onComplete : undefined
          )
        }
        const answer = readKnownCodexHookAnswer()
        if (answer?.kind !== 'hashes') {
          this.completedLaunchPrep.delete(key)
          return refresh()
        }
        const answerKey = JSON.stringify(answer)
        return this.reuseCompletedPreparation(
          key,
          homePath,
          answerKey,
          () => JSON.stringify(readKnownCodexHookAnswer()),
          refresh
        )
      })
    const status = await (configPreparation
      ? run()
      : dedupeInFlightRun(this.launchPrepInFlight, key, run))
    configPreparation?.complete()
    return status
  }

  private async reuseCompletedPreparation(
    key: string,
    homePath: string,
    context: string,
    readContext: () => string | null,
    run: (onComplete?: () => void) => Promise<AgentHookInstallStatus>
  ): Promise<AgentHookInstallStatus> {
    const before = await readCodexLaunchPreparationInputs(homePath)
    if (readContext() !== context) {
      this.completedLaunchPrep.delete(key)
      return run()
    }
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
          (await readCodexLaunchPreparationInputs(homePath, isStillValid))?.digest ===
            before.digest &&
          readContext() === context
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
