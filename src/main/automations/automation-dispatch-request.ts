import { failedPrecheckResult, runAutomationPrecheck } from './precheck-runner'
import { isDeepStrictEqual } from 'node:util'
import type { Automation } from '../../shared/automations/automation-definition'
import type {
  AutomationRun,
  AutomationPrecheckResult
} from '../../shared/automations/history/automation-run'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { Store } from '../persistence/loading-store/store'
import type { AutomationRunWriter } from './automation-run-writer'
import type { AutomationLauncher } from './automation-launch'
import type { AutomationLaunchContext } from './automation-launch-runner'
import { AutomationDispatchRefusedError, runAutomationLaunch } from './automation-launch-runner'
import type { AutomationRunTargetResult } from './run-target-resolution'
import { describeScheduledRefusal, describeStoppedWslDistroRefusal } from './dispatch-refusal'
import {
  automationRunFailure,
  type AutomationRunFailure
} from '../../shared/automations/history/automation-run-failure-copy'
import { isOrcadFencedAutomation, ORCAD_FENCED_AUTOMATION } from './orcad-fenced-automation'
import { AutomationDispatchCancelledError } from './automation-dispatch-cancelled-error'

export { AutomationDispatchCancelledError }

type DispatchContext = Pick<
  AutomationLaunchContext,
  'runPrecheck' | 'markDispatchResult' | 'watchRun'
> & {
  store: Store
  runs: AutomationRunWriter
  isActive(): boolean
  /** Read at each check: a window graph can close while the claim is acknowledged. */
  launcher(): AutomationLauncher | null
  chatDispatcher?: AutomationLauncher | null
  resolveTarget(automation: Automation): AutomationRunTargetResult
}

function definition(automation: Automation) {
  const { lastRunAt: _last, updatedAt: _updated, nextRunAt: _next, ...configured } = automation
  return configured
}

function destination(target: Extract<AutomationRunTargetResult, { ok: true }>) {
  return {
    cwd: target.cwd,
    repoId: target.repo.id,
    repoPath: target.repo.path,
    host: getRepoExecutionHostId(target.repo),
    setupId: target.setup?.id
  }
}

/** Claim durably, then recheck everything that an acknowledgement wait can invalidate. */
export async function requestAutomationDispatch(
  ctx: DispatchContext,
  automation: Automation,
  run: AutomationRun,
  expectedTarget: AutomationRunTargetResult
): Promise<AutomationRun> {
  const expectedDefinition = structuredClone(definition(automation))
  const expectedDestination = expectedTarget.ok ? destination(expectedTarget) : undefined
  const readRun = (): AutomationRun => {
    if (!ctx.isActive()) {
      throw new AutomationDispatchCancelledError(
        'Orca stopped before this automation could launch.'
      )
    }
    const current = ctx.store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)
    if (!current || !ctx.store.listAutomations().some((entry) => entry.id === automation.id)) {
      throw new AutomationDispatchCancelledError(
        'The automation was removed before it could launch.'
      )
    }
    // A refusal row would change the fenced export; restart strands the run instead.
    if (isOrcadFencedAutomation(ctx.store, automation)) {
      throw new AutomationDispatchCancelledError(ORCAD_FENCED_AUTOMATION)
    }
    return current
  }
  const resolveCurrentTarget = (): AutomationRunTargetResult => {
    const current = ctx.store.listAutomations().find((entry) => entry.id === automation.id)
    if (!current || !isDeepStrictEqual(expectedDefinition, definition(current))) {
      return { ok: false, ...automationRunFailure('automationChanged') }
    }
    const target = ctx.resolveTarget(current)
    if (
      target.ok &&
      expectedDestination &&
      !isDeepStrictEqual(expectedDestination, destination(target))
    ) {
      return { ok: false, ...automationRunFailure('destinationChanged') }
    }
    return target
  }
  const refuse = (failure: AutomationRunFailure) =>
    ctx.runs.updateRun({
      runId: run.id,
      status: 'skipped_unavailable',
      workspaceId: automation.workspaceId,
      ...failure
    })
  const returnDurable = async (current: AutomationRun) => {
    await ctx.store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    return current
  }

  run = readRun()
  if (run.status !== 'pending') {
    return returnDurable(run)
  }
  let target = resolveCurrentTarget()
  const refusal = describeScheduledRefusal({
    target,
    canDispatch:
      automation.surface === 'chat' ? Boolean(ctx.chatDispatcher) : Boolean(ctx.launcher())
  })
  if (refusal || !target.ok) {
    return refuse(refusal ?? automationRunFailure('noDispatchHost'))
  }
  // The distro may have stopped since the tick decided; a manual run may start it.
  const stopped =
    run.trigger === 'scheduled' ? await describeStoppedWslDistroRefusal(ctx.store, target) : null
  if (stopped) {
    return refuse(stopped)
  }
  await ctx.runs.updateRun({
    runId: run.id,
    status: 'dispatching',
    workspaceId: automation.workspaceId,
    error: null
  })

  run = readRun()
  if (run.status !== 'dispatching') {
    return returnDurable(run)
  }
  target = resolveCurrentTarget()
  // A WSL move can start while the durable claim is pending.
  const lateRefusal = describeScheduledRefusal({ target, canDispatch: true })
  if (lateRefusal || !target.ok) {
    return refuse(lateRefusal ?? automationRunFailure('noDispatchHost'))
  }
  const dispatcher = automation.surface === 'chat' ? ctx.chatDispatcher : ctx.launcher()
  if (!dispatcher) {
    return refuse(automationRunFailure('noDispatchHost'))
  }
  return runAutomationLaunch({
    ...ctx,
    automation,
    run,
    target,
    // The status check and the store write share one synchronous step, so a settled run stays settled.
    transition: (result) => {
      const current = readRun()
      return current.status === 'dispatching'
        ? { applied: true, run: ctx.runs.updateRun({ runId: run.id, ...result }) }
        : { applied: false, run: returnDurable(current) }
    },
    dispatcher: (request) => {
      if (readRun().status !== 'dispatching') {
        throw new AutomationDispatchCancelledError('The run changed before its agent could launch.')
      }
      const latestTarget = resolveCurrentTarget()
      if (!latestTarget.ok) {
        throw new AutomationDispatchCancelledError(latestTarget.error)
      }
      // Recheck WSL moves after a potentially long precheck so refusal remains a skip.
      const latestRefusal = describeScheduledRefusal({
        target: latestTarget,
        canDispatch: true
      })
      if (latestRefusal) {
        throw new AutomationDispatchRefusedError(latestRefusal)
      }
      return dispatcher({ ...request, target: latestTarget })
    }
  })
}

export async function runAutomationRequestPrecheck(
  store: Store,
  automationId: string,
  runId: string,
  resolveTarget: (automation: Automation) => AutomationRunTargetResult
): Promise<AutomationPrecheckResult | null> {
  const automation = store.listAutomations().find((entry) => entry.id === automationId)
  if (!automation) {
    throw new Error('Automation not found.')
  }
  const run = store.listAutomationRuns(automationId).find((entry) => entry.id === runId)
  if (!run) {
    throw new Error('Automation run not found.')
  }
  if (run.trigger !== 'scheduled' || !automation.precheck) {
    return null
  }
  const target = resolveTarget(automation)
  if (!target.ok) {
    return failedPrecheckResult(automation.precheck, Date.now(), target.error)
  }
  return await runAutomationPrecheck({
    precheck: automation.precheck,
    target:
      automation.executionTargetType === 'ssh'
        ? { type: 'ssh', cwd: target.cwd, connectionId: automation.executionTargetId }
        : { type: 'local', cwd: target.cwd }
  })
}
