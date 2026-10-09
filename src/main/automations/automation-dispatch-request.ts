import type { WebContents } from 'electron'
import { isDeepStrictEqual } from 'node:util'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { Store } from '../persistence'
import type { AutomationRunWriter } from './automation-run-writer'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { HeadlessAutomationDispatchContext } from './headless-dispatch-runner'
import { runHeadlessAutomationDispatch } from './headless-dispatch-runner'
import type { AutomationRunTargetResult } from './run-target-resolution'
import { createAutomationDispatchToken } from './dispatch-tokens'
import { automationPromptForRun } from './rerun-prompt'
import { NO_DISPATCH_HOST, sendRendererDispatch } from './dispatch-refusal'

export type AutomationRendererChannel = Pick<WebContents, 'isDestroyed' | 'send'>

export class AutomationDispatchCancelledError extends Error {}

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
    return current
  }
  const resolveCurrentTarget = (): AutomationRunTargetResult => {
    const current = ctx.store.listAutomations().find((entry) => entry.id === automation.id)
    if (!current || !isDeepStrictEqual(expectedDefinition, definition(current))) {
      return { ok: false, error: 'The automation changed before this run could launch.' }
    }
    const target = ctx.resolveTarget(current)
    if (
      target.ok &&
      expectedDestination &&
      !isDeepStrictEqual(expectedDestination, destination(target))
    ) {
      return {
        ok: false,
        error: 'The automation destination changed before this run could launch.'
      }
    }
    return target
  }
  const refuse = (error: string) =>
    ctx.runs.updateRun({
      runId: run.id,
      status: 'skipped_unavailable',
      workspaceId: automation.workspaceId,
      error
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
  if (!target.ok || (!ctx.getRenderer() && !ctx.headlessDispatcher)) {
    return refuse(target.ok ? NO_DISPATCH_HOST : target.error)
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
  if (!target.ok) {
    return refuse(target.error)
  }
  const dispatchAutomation = { ...automation, prompt: automationPromptForRun(automation, run) }
  const renderer = ctx.getRenderer()
  if (renderer) {
    return sendRendererDispatch(
      renderer,
      {
        automation: dispatchAutomation,
        run,
        dispatchToken: createAutomationDispatchToken(automation.id, run.id)
      },
      ctx.runs,
      run
    )
  }
  const dispatcher = ctx.headlessDispatcher
  if (!dispatcher) {
    return refuse(NO_DISPATCH_HOST)
  }
  return runHeadlessAutomationDispatch({
    ...ctx,
    automation: dispatchAutomation,
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
      return dispatcher({ ...request, target: latestTarget })
    }
  })
}
