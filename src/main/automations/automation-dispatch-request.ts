import type { WebContents } from 'electron'
import { isDeepStrictEqual } from 'node:util'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { Store } from '../persistence'
import type { AutomationRunWriter } from './automation-run-writer'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { HeadlessAutomationDispatchContext } from './headless-dispatch-runner'
import {
  AutomationDispatchRefusedError,
  runHeadlessAutomationDispatch
} from './headless-dispatch-runner'
import type { AutomationRunTargetResult } from './run-target-resolution'
import { createAutomationDispatchToken } from './dispatch-tokens'
import {
  describeScheduledRefusal,
  describeStoppedWslDistroRefusal,
  sendRendererDispatch
} from './dispatch-refusal'
import {
  automationRunFailure,
  type AutomationRunFailure
} from '../../shared/automation-run-failure-copy'
import { isOrcadFencedAutomation, ORCAD_FENCED_AUTOMATION } from './orcad-fenced-automation'
import { AutomationDispatchCancelledError } from './automation-dispatch-cancelled-error'

export type AutomationRendererChannel = Pick<WebContents, 'isDestroyed' | 'send'>

export { AutomationDispatchCancelledError }

type DispatchContext = Pick<
  HeadlessAutomationDispatchContext,
  'runPrecheck' | 'markDispatchResult' | 'watchRun'
> & {
  store: Store
  runs: AutomationRunWriter
  isActive(): boolean
  getRenderer(): AutomationRendererChannel | null
  headlessDispatcher: HeadlessAutomationDispatcher | null
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
    canDispatch: Boolean(ctx.getRenderer() || ctx.headlessDispatcher)
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
  const renderer = ctx.getRenderer()
  if (renderer) {
    return sendRendererDispatch(
      renderer,
      {
        automation,
        run,
        dispatchToken: createAutomationDispatchToken(automation.id, run.id)
      },
      ctx.runs,
      run
    )
  }
  const dispatcher = ctx.headlessDispatcher
  if (!dispatcher) {
    return refuse(automationRunFailure('noDispatchHost'))
  }
  return runHeadlessAutomationDispatch({
    ...ctx,
    automation,
    run,
    target,
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
