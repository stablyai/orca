import {
  canonicalizeSkillUpdateNames,
  type SkillUpdateRun,
  type SkillUpdateStartResult
} from '../../shared/skill-freshness'
import type { SkillInstallResult } from '../../shared/skill-install-contract'
import { describeBundledSkillInstallResult } from './bundled-orca-skill-install-report'

export type SkillUpdateRunnerDeps = {
  /** Installs this build's copy of each name on the host the inventory scans. */
  installSkills: (names: string[], signal: AbortSignal) => Promise<SkillInstallResult[]>
  /** Returns the subset of `names` that did not land, re-read from disk. */
  rescanOutdatedNames?: (names: string[]) => Promise<string[]>
  now?: () => number
  onState?: (run: SkillUpdateRun) => void
}

const UPDATE_FAILED_MESSAGE = 'Some skills could not be updated.'

function failedNames(results: readonly SkillInstallResult[]): string[] {
  return results
    .filter((result) => !['installed', 'updated', 'unchanged'].includes(result.status))
    .map((result) => result.name)
}

/** Brings Orca's own skills to this build's bytes with Orca's skill installer. */
export class SkillUpdateRunner {
  private run: SkillUpdateRun = { state: 'idle' }
  private controller: AbortController | null = null
  // Why: a cancelled run's install still settles later; the token keeps its verdict out of
  // the run that replaced it.
  private runToken = 0
  private readonly deps: Required<Pick<SkillUpdateRunnerDeps, 'now'>> & SkillUpdateRunnerDeps

  constructor(deps: SkillUpdateRunnerDeps) {
    this.deps = { now: () => Date.now(), ...deps }
  }

  getState(): SkillUpdateRun {
    return this.run
  }

  private publish(next: SkillUpdateRun): void {
    this.run = next
    this.deps.onState?.(next)
  }

  start(names: readonly string[]): SkillUpdateStartResult {
    if (this.run.state === 'running') {
      return { started: false, reason: 'already-running' }
    }
    const canonicalNames = canonicalizeSkillUpdateNames(names)
    if (!canonicalNames) {
      return { started: false, reason: 'invalid-names' }
    }
    const token = ++this.runToken
    const controller = new AbortController()
    this.controller = controller
    this.publish({
      state: 'running',
      names: canonicalNames,
      startedAt: this.deps.now(),
      output: ''
    })
    void this.deps.installSkills(canonicalNames, controller.signal).then(
      (results) => this.settle(token, canonicalNames, results, null),
      (error: unknown) =>
        this.settle(
          token,
          canonicalNames,
          [],
          error instanceof Error ? error.message : String(error)
        )
    )
    return { started: true }
  }

  private async settle(
    token: number,
    names: string[],
    results: readonly SkillInstallResult[],
    installError: string | null
  ): Promise<void> {
    if (token !== this.runToken) {
      return
    }
    this.controller = null
    const output = [
      ...results.map(describeBundledSkillInstallResult),
      ...(installError ? [installError] : [])
    ].join('\n')
    const finishedAt = this.deps.now()
    // Why the re-scan wins when it answers: it re-hashes what is on disk, which is what the
    // dialog reports on; the install results only stand in when it cannot.
    const rescanned = await this.deps.rescanOutdatedNames?.(names).catch(() => null)
    if (token !== this.runToken) {
      return
    }
    // Why after the re-scan: a stopped run may still have written some skills, and the
    // re-scan is what refreshes the copies the dialog shows.
    if (this.run.state === 'running' && this.run.stopping) {
      this.publish({ state: 'idle' })
      return
    }
    const failed = rescanned ?? (installError ? names : failedNames(results))
    if (failed.length === 0) {
      this.publish({ state: 'success', names, finishedAt, output })
      return
    }
    this.publish({
      state: 'error',
      names,
      finishedAt,
      output,
      failedNames: failed,
      message: UPDATE_FAILED_MESSAGE
    })
  }

  cancel(): void {
    if (this.run.state !== 'running' || this.run.stopping) {
      return
    }
    // Why stay `running` until the install settles: a second run would write the same
    // skill folders while the first transaction is still rolling back.
    this.publish({ ...this.run, stopping: true })
    this.controller?.abort()
  }

  /** Clears a settled run so the status-bar segment can retire itself. */
  acknowledge(): void {
    if (this.run.state === 'success' || this.run.state === 'error') {
      this.publish({ state: 'idle' })
    }
  }
}
