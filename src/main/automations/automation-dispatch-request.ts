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
import { NO_DISPATCH_HOST, sendRendererDispatch } from './dispatch-refusal'
import {
  automationDefinition,
  type RunnableAutomationTarget
} from './automation-workspace-recovery'

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
  resolveTarget(
    automation: Automation
  ): AutomationRunTargetResult | Promise<AutomationRunTargetResult>
  prepareWorkspace?(
    automation: Automation,
    run: AutomationRun,
    target: RunnableAutomationTarget,
    assertCurrent: () => Promise<RunnableAutomationTarget>
  ): Promise<{ automation: Automation; target: RunnableAutomationTarget }>
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
  let expectedDefinition = structuredClone(automationDefinition(automation))
  let expectedDestination = expectedTarget.ok ? destination(expectedTarget) : undefined
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
  const resolveCurrentTarget = async (): Promise<AutomationRunTargetResult> => {
    const current = ctx.store.listAutomations().find((entry) => entry.id === automation.id)
    if (!current || !isDeepStrictEqual(expectedDefinition, automationDefinition(current))) {
      return { ok: false, error: 'The automation changed before this run could launch.' }
    }
    const target = await ctx.resolveTarget(current)
    const latest = ctx.store.listAutomations().find((entry) => entry.id === automation.id)
    if (!latest || !isDeepStrictEqual(expectedDefinition, automationDefinition(latest))) {
      return { ok: false, error: 'The automation changed before this run could launch.' }
    }
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
  const refuse = (
    error: string,
    status: 'skipped_unavailable' | 'skipped_needs_interactive_auth' = 'skipped_unavailable'
  ) => {
    const current = readRun()
    if (current.status !== 'pending' && current.status !== 'dispatching') {
      return returnDurable(current)
    }
    return ctx.runs.updateRun({
      runId: run.id,
      status,
      workspaceId: automation.workspaceId,
      error
    })
  }
  const returnDurable = async (current: AutomationRun) => {
    await ctx.store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    return current
  }

  run = readRun()
  if (run.status !== 'pending') {
    return returnDurable(run)
  }
  let target = await resolveCurrentTarget()
  if (!target.ok || (!ctx.getRenderer() && !ctx.headlessDispatcher)) {
    return refuse(
      target.ok ? NO_DISPATCH_HOST : target.error,
      target.ok ? undefined : target.status
    )
  }
  run = readRun()
  if (run.status !== 'pending') {
    return returnDurable(run)
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
  target = await resolveCurrentTarget()
  if (!target.ok) {
    return refuse(target.error, target.status)
  }
  if (ctx.prepareWorkspace && target.workspace === null) {
    try {
      const prepared = await ctx.prepareWorkspace(automation, run, target, async () => {
        if (readRun().status !== 'dispatching') {
          throw new AutomationDispatchCancelledError(
            'The run changed before its workspace could be replaced.'
          )
        }
        const latest = await resolveCurrentTarget()
        if (!latest.ok) {
          throw new AutomationDispatchCancelledError(latest.error)
        }
        if (readRun().status !== 'dispatching') {
          throw new AutomationDispatchCancelledError(
            'The run changed before its workspace could be replaced.'
          )
        }
        return latest
      })
      automation = prepared.automation
      expectedDefinition = structuredClone(automationDefinition(automation))
      expectedDestination = destination(prepared.target)
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
    if (readRun().status !== 'dispatching') {
      return returnDurable(readRun())
    }
    target = await resolveCurrentTarget()
    if (!target.ok) {
      return refuse(target.error, target.status)
    }
    if (readRun().status !== 'dispatching') {
      return returnDurable(readRun())
    }
    if (run.workspaceId !== automation.workspaceId) {
      run = await ctx.runs.updateRun({
        runId: run.id,
        status: 'dispatching',
        workspaceId: automation.workspaceId,
        workspaceDisplayName: target.workspace?.displayName,
        error: null
      })
      target = await resolveCurrentTarget()
      if (!target.ok) {
        return refuse(target.error, target.status)
      }
    }
  }
  run = readRun()
  if (run.status !== 'dispatching') {
    return returnDurable(run)
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
    return refuse(NO_DISPATCH_HOST)
  }
  return runHeadlessAutomationDispatch({
    ...ctx,
    automation,
    run,
    target,
    dispatcher: async (request) => {
      if (readRun().status !== 'dispatching') {
        throw new AutomationDispatchCancelledError('The run changed before its agent could launch.')
      }
      const latestTarget = await resolveCurrentTarget()
      if (!latestTarget.ok) {
        throw new AutomationDispatchCancelledError(latestTarget.error)
      }
      if (readRun().status !== 'dispatching') {
        throw new AutomationDispatchCancelledError('The run changed before its agent could launch.')
      }
      return dispatcher({ ...request, target: latestTarget })
    }
  })
}
