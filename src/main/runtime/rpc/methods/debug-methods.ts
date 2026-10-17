import { isAbsolute, resolve } from 'node:path'
import { defineMethod } from '../core'
import { debugService, DebugServiceError } from '../../../debug/debug-service'
import { isInsideRoot, normalizeDebugPath } from '../../../debug/debug-breakpoint-store'
import type {
  DebugResult,
  DebugSnapshot,
  DebugStatus,
  DebugWorktree
} from '../../../../preload/api/debug-api'
import {
  DEBUG_MAX_BREAKPOINTS,
  DebugBreakpointLocationParams,
  DebugBreakpointSetParams,
  DebugEventsParams,
  DebugStartParams,
  DebugThreadParams,
  DebugWaitParams,
  DebugWorktreeParams
} from '../../../../shared/rpc-contract/debug-params'
import {
  DEBUG_INSPECT_METHODS,
  debugResult,
  defaultThreadId,
  resolveDebugTarget,
  toDebugRefusal
} from './debug-methods-inspect'

// No approve method on purpose: approveLaunch needs a HumanConfirmation only the IPC handlers mint.

const WAIT_STATUSES: Record<'stopped' | 'terminated' | 'either', readonly DebugStatus[]> = {
  stopped: ['stopped'],
  terminated: ['terminated', 'failed'],
  either: ['stopped', 'terminated', 'failed']
}

/** A relative path is the worktree's; anything outside it is refused before core sees it. */
function worktreeFile(target: DebugWorktree, path: string): string {
  const file = isAbsolute(path) ? path : resolve(target.worktreePath, path)
  if (!isInsideRoot(target.worktreePath, file)) {
    throw new DebugServiceError('outside-worktree', `${path} is outside ${target.worktreePath}`)
  }
  return file
}

const STEPS = ['continue', 'next', 'stepIn', 'stepOut', 'pause'] as const

/** A start or restart answers with the seq a following `wait` counts from. */
async function withControlSeq(target: DebugWorktree, work: Promise<DebugResult<DebugSnapshot>>) {
  const result = await work
  const controlSeq = result.ok ? await debugService.cliControlSeq(target) : null
  return result.ok ? { ok: true as const, value: { ...result.value, controlSeq } } : result
}

const STEP_METHODS = STEPS.map((step) =>
  defineMethod({
    name: `debug.${step}`,
    permission: 'workspace',
    params: DebugThreadParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      return debugResult(async () => {
        const session = await debugService.control(target, 'cli')
        const threadId = await defaultThreadId(target, session, params.threadId)
        // Stamped right before the request, so `wait` after it cannot miss a fast stop.
        const controlSeq = debugService.markCliControl(session)
        await session[step](threadId)
        return { threadId, controlSeq }
      })
    }
  })
)

export const DEBUG_METHODS = [
  defineMethod({
    name: 'debug.status',
    permission: 'workspace',
    params: DebugWorktreeParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      return debugResult(() => debugService.snapshot(target))
    }
  }),
  defineMethod({
    name: 'debug.configs',
    permission: 'workspace',
    params: DebugWorktreeParams,
    handler: async (params, { runtime }) => {
      const { repoId, worktreePath } = await resolveDebugTarget(runtime, params.worktree)
      try {
        return await debugService.listConfigs(repoId, worktreePath)
      } catch (error) {
        return toDebugRefusal(error)
      }
    }
  }),
  defineMethod({
    name: 'debug.start',
    permission: 'workspace',
    params: DebugStartParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      try {
        // languageId is left to core, which derives it from the file.
        const started = debugService.start({
          ...target,
          configName: params.config,
          filePath: params.file === undefined ? undefined : worktreeFile(target, params.file),
          lineNumber: params.line,
          expectedHash: params.expectedHash,
          origin: 'cli'
        })
        return await withControlSeq(target, started)
      } catch (error) {
        return toDebugRefusal(error)
      }
    }
  }),
  defineMethod({
    name: 'debug.stop',
    permission: 'workspace',
    params: DebugWorktreeParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      try {
        return await debugService.stop(target, 'cli')
      } catch (error) {
        return toDebugRefusal(error)
      }
    }
  }),
  defineMethod({
    name: 'debug.restart',
    permission: 'workspace',
    params: DebugWorktreeParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      try {
        return await withControlSeq(target, debugService.restart(target, 'cli'))
      } catch (error) {
        return toDebugRefusal(error)
      }
    }
  }),
  ...STEP_METHODS,
  ...DEBUG_INSPECT_METHODS,
  defineMethod({
    name: 'debug.breakpoints.list',
    permission: 'workspace',
    params: DebugWorktreeParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      return debugResult(() => debugService.listBreakpoints(target))
    }
  }),
  defineMethod({
    name: 'debug.breakpoints.set',
    permission: 'workspace',
    params: DebugBreakpointSetParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      const existing = await debugResult(() => debugService.listBreakpoints(target))
      if (existing.ok && (existing.value?.length ?? 0) >= DEBUG_MAX_BREAKPOINTS) {
        const message = `This worktree already has ${DEBUG_MAX_BREAKPOINTS} breakpoints; remove some first.`
        return { ok: false as const, reason: 'too-many-breakpoints' as const, message }
      }
      return debugResult(async () => {
        const { line, condition, hitCondition, logMessage } = params
        const fields = { line, condition, hitCondition, logMessage }
        const file = worktreeFile(target, params.path)
        return debugService.addBreakpoint(target, file, fields, 'cli')
      })
    }
  }),
  defineMethod({
    name: 'debug.breakpoints.remove',
    permission: 'workspace',
    params: DebugBreakpointLocationParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      return debugResult(async () => {
        const file = normalizeDebugPath(worktreeFile(target, params.path))
        const matches = (await debugService.listBreakpoints(target)).filter(
          (bp) => bp.path === file && bp.line === params.line
        )
        if (matches.length === 0) {
          const where = `${params.path}:${params.line}`
          throw new DebugServiceError('unknown-breakpoint', `No breakpoint at ${where}`)
        }
        for (const bp of matches) {
          await debugService.removeBreakpoint(target, bp.id, 'cli')
        }
        return { removed: matches.map((bp) => bp.id) }
      })
    }
  }),
  defineMethod({
    name: 'debug.events',
    permission: 'workspace',
    params: DebugEventsParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      return debugResult(() => debugService.eventsSince(target, params.since ?? 0))
    }
  }),
  defineMethod({
    name: 'debug.wait',
    permission: 'workspace',
    params: DebugWaitParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      const statuses = WAIT_STATUSES[params.for]
      return debugResult(async () => {
        const since = params.since ?? (await debugService.cliControlSeq(target)) ?? undefined
        return debugService.waitFor(target, statuses, params.timeoutMs, since)
      })
    }
  })
]
