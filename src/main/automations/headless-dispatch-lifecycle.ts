import type {
  Automation,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../shared/automations-types'
import type { Store } from '../persistence'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { AutomationRunTargetResult } from './run-target-resolution'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../shared/automation-precheck'

const HEADLESS_LAUNCH_CLEANUP_TIMEOUT_MS = 10_000

export class HeadlessLaunchCleanupRegistry {
  private readonly cleanups = new Map<string, () => Promise<void>>()

  register(runId: string, cleanup: () => Promise<void>): void {
    this.cleanups.set(runId, cleanup)
  }

  clear(runId: string): void {
    this.cleanups.delete(runId)
  }

  async run(runId: string): Promise<void> {
    const cleanup = this.cleanups.get(runId)
    this.cleanups.delete(runId)
    if (!cleanup) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        resolve()
      }
      timer = setTimeout(finish, HEADLESS_LAUNCH_CLEANUP_TIMEOUT_MS)
      void Promise.resolve()
        .then(cleanup)
        .catch(() => {})
        .then(finish)
    })
  }
}

export async function requestHeadlessAutomationDispatch(params: {
  store: Store
  automation: Automation
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
  headlessDispatcher: HeadlessAutomationDispatcher
  codexHeadlessLaunchTimeoutMs: number
  runPrecheck: (automationId: string, runId: string) => Promise<AutomationPrecheckResult | null>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
  registerLaunchCleanup?: (runId: string, cleanup: () => Promise<void>) => void
  clearLaunchCleanup?: (runId: string) => void
  cleanupLaunch?: (runId: string) => Promise<void>
}): Promise<AutomationRun> {
  const { automation, run } = params
  const precheckResult =
    run.trigger === 'scheduled' && automation.precheck
      ? await params.runPrecheck(automation.id, run.id)
      : null
  if (precheckResult && !didAutomationPrecheckPass(precheckResult)) {
    return params.store.updateAutomationRun({
      runId: run.id,
      status: 'skipped_precheck',
      workspaceId: automation.workspaceId,
      precheckResult,
      error: formatAutomationPrecheckFailure(precheckResult)
    })
  }

  try {
    const launch = await params.headlessDispatcher({
      automation,
      run,
      target: params.target
    })
    const launchDeadlineAt =
      automation.agentId === 'codex' ? Date.now() + params.codexHeadlessLaunchTimeoutMs : null
    const launchRunTarget = {
      workspaceId: launch.workspaceId,
      workspaceDisplayName: launch.workspaceDisplayName ?? null,
      terminalSessionId: launch.terminalSessionId,
      terminalPaneKey: launch.terminalPaneKey ?? null,
      terminalPtyId: launch.terminalPtyId ?? null
    }
    if (launch.cleanup) {
      params.registerLaunchCleanup?.(run.id, launch.cleanup)
    }
    const updated = await params.markDispatchResult({
      runId: run.id,
      status: 'dispatched',
      ...launchRunTarget,
      launchDeadlineAt,
      launchEvidenceAt: null,
      error: null
    })
    const launchReady =
      typeof launch.launchReady === 'function'
        ? launchDeadlineAt === null
          ? null
          : launch.launchReady(launchDeadlineAt)
        : launch.launchReady
    if (launchReady) {
      void launchReady
        .then(async () => {
          await params.markDispatchResult({
            runId: run.id,
            status: 'dispatched',
            launchEvidenceAt: Date.now()
          })
          params.clearLaunchCleanup?.(run.id)
        })
        .catch(async (error) => {
          await params
            .markDispatchResult({
              runId: run.id,
              status: 'dispatch_failed',
              ...launchRunTarget,
              error: error instanceof Error ? error.message : String(error)
            })
            .catch(() => {})
          if (params.cleanupLaunch) {
            await params.cleanupLaunch(run.id).catch(() => {})
          }
          params.clearLaunchCleanup?.(run.id)
        })
    }
    if (launch.completion) {
      void launch.completion
        .then(async (completion) => {
          await params.markDispatchResult({
            runId: run.id,
            status: completion.status,
            ...launchRunTarget,
            precheckResult,
            outputSnapshot: completion.outputSnapshot ?? null,
            error: completion.error ?? null
          })
          params.clearLaunchCleanup?.(run.id)
        })
        .catch(async (error) => {
          await params
            .markDispatchResult({
              runId: run.id,
              status: 'dispatch_failed',
              ...launchRunTarget,
              error: error instanceof Error ? error.message : String(error)
            })
            .catch(() => {})
          // Why: an unexpected completion rejection still owns the PTY and any
          // per-run worktree; clearing the registration alone would leak both.
          if (params.cleanupLaunch) {
            await params.cleanupLaunch(run.id).catch(() => {})
          }
          params.clearLaunchCleanup?.(run.id)
        })
    }
    return updated
  } catch (error) {
    // Why: a throw after the cleanup registration leaves no later trigger for it,
    // and markDispatchResult owns dispatch-token clearing plus the final-state guard.
    if (params.cleanupLaunch) {
      await params.cleanupLaunch(run.id).catch(() => {})
    }
    params.clearLaunchCleanup?.(run.id)
    return params.markDispatchResult({
      runId: run.id,
      status: 'dispatch_failed',
      workspaceId: automation.workspaceId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function reconcileStaleCodexHeadlessDispatches(params: {
  store: Store
  now: number
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
  cleanupLaunch?: (runId: string) => Promise<void>
  clearLaunchCleanup?: (runId: string) => void
}): Promise<void> {
  const staleRuns: AutomationRun[] = []
  for (const automation of params.store.listAutomations()) {
    if (automation.agentId !== 'codex') {
      continue
    }
    for (const run of params.store.listAutomationRuns(automation.id)) {
      if (
        run.status !== 'dispatched' ||
        run.launchEvidenceAt != null ||
        run.launchDeadlineAt == null ||
        run.launchDeadlineAt > params.now
      ) {
        continue
      }
      staleRuns.push(run)
    }
  }
  await Promise.all(
    staleRuns.map(async (run) => {
      await params
        .markDispatchResult({
          runId: run.id,
          status: 'dispatch_failed',
          workspaceId: run.workspaceId,
          workspaceDisplayName: run.workspaceDisplayName,
          terminalSessionId: run.terminalSessionId,
          terminalPaneKey: run.terminalPaneKey,
          terminalPtyId: run.terminalPtyId,
          error: 'Codex headless agent did not produce launch evidence before the deadline.'
        })
        .catch(() => {})
      if (params.cleanupLaunch) {
        await params.cleanupLaunch(run.id).catch(() => {})
      }
      params.clearLaunchCleanup?.(run.id)
    })
  )
}
