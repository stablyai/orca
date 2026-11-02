import type { WorktreeCreateTiming } from '../shared/worktree/create-types'
import type { WorkspaceCreateEntryPoint } from '../shared/worktree/create-timing-vocabulary'
import { workspaceSourceSchema } from '../shared/telemetry-events'
import type { EventProps, WorkspaceSource } from '../shared/telemetry-events'
import { isTelemetryEnabled, track } from './telemetry/client'
import { getCohortAtEmit } from './telemetry/cohort-classifier'
import { classifyWorkspaceCreateError } from './ipc/workspace-create-error-classifier'
import { probeCreateEventRepoFacts } from './git/create-event-repo-probe'
import {
  createWorktreeCreateTimingRecorder,
  type WorktreeCreateTimingRecorder
} from './worktree-create-timing'
import { beginWorktreeCreate } from './worktree-create-concurrency'
import {
  workspaceCreateFailureFields,
  workspaceCreateTimingFields,
  type WorkspaceCreateEventContext
} from './workspace-create-event-fields'

export type WorkspaceCreateTelemetry = {
  readonly timing: WorktreeCreateTimingRecorder
  succeeded(timing?: WorktreeCreateTiming): void
  failed(error: unknown): void
}

export type WorkspaceCreateTelemetryArgs = {
  source: unknown
  entryPoint: WorkspaceCreateEntryPoint
  repoPath: string
  fromExistingBranch: boolean
  /** Folder workspaces omit Git timing and disk-concurrency fields. */
  isFolder: boolean
}

export function beginWorkspaceCreateTelemetry(
  args: WorkspaceCreateTelemetryArgs
): WorkspaceCreateTelemetry {
  const sourceParse = workspaceSourceSchema.safeParse(args.source)
  const source: WorkspaceSource = sourceParse.success ? sourceParse.data : 'unknown'
  const inFlight = args.isFolder ? null : beginWorktreeCreate()
  const timing = createWorktreeCreateTimingRecorder(undefined, inFlight ?? undefined)
  let settled = false
  const settleOnce = (send: () => void): void => {
    if (settled) {
      return
    }
    settled = true
    try {
      send()
    } catch (error) {
      // Bookkeeping must never change the outcome of the create it describes.
      console.warn('[worktree-create] create event could not be sent', error)
    } finally {
      inFlight?.end()
    }
  }

  return {
    timing,
    succeeded(createTiming) {
      settleOnce(() => {
        const props: EventProps<'workspace_created'> = {
          source,
          from_existing_branch: !args.isFolder && args.fromExistingBranch,
          ...getCohortAtEmit()
        }
        if (!inFlight) {
          track('workspace_created', props)
          return
        }
        void trackWorkspaceCreated(props, args.repoPath, createTiming ?? timing.finish(), {
          entryPoint: args.entryPoint,
          concurrency: inFlight.end()
        }).catch((error: unknown) => {
          console.warn('[worktree-create] create event could not be sent', error)
        })
      })
    },
    failed(error) {
      settleOnce(() => {
        track('workspace_create_failed', {
          source,
          error_class: classifyWorkspaceCreateError(error),
          ...getCohortAtEmit(),
          ...(inFlight
            ? workspaceCreateFailureFields(timing, {
                entryPoint: args.entryPoint,
                concurrency: inFlight.end(),
                error
              })
            : {})
        })
      })
    }
  }
}

export type RuntimeWorkspaceCreateEvents = {
  begin(repoPath: string): WorktreeCreateTimingRecorder
}

/** Settle concurrency counts before returning, so subsequent preparation work is excluded. */
export async function trackRuntimeWorkspaceCreate<T>(
  request: { telemetrySource?: unknown; baseBranch?: string },
  perform: (events: RuntimeWorkspaceCreateEvents) => Promise<T>
): Promise<T> {
  const session: { current?: WorkspaceCreateTelemetry } = {}
  try {
    const result = await perform({
      begin(repoPath) {
        session.current = beginWorkspaceCreateTelemetry({
          source: request.telemetrySource,
          entryPoint: 'runtime',
          repoPath,
          fromExistingBranch:
            typeof request.baseBranch === 'string' && request.baseBranch.length > 0,
          isFolder: false
        })
        return session.current.timing
      }
    })
    session.current?.succeeded()
    return result
  } catch (error) {
    session.current?.failed(error)
    throw error
  }
}

/** Probe asynchronously so repository inspection does not delay creation. */
async function trackWorkspaceCreated(
  props: EventProps<'workspace_created'>,
  repoPath: string,
  timing: WorktreeCreateTiming,
  context: WorkspaceCreateEventContext
): Promise<void> {
  // Avoid SSH round trips; disabled telemetry must not inspect repositories.
  const repoFacts =
    isTelemetryEnabled() && (timing.executionHost === 'local' || timing.executionHost === 'wsl')
      ? await probeCreateEventRepoFacts(repoPath)
      : undefined
  track('workspace_created', {
    ...props,
    ...workspaceCreateTimingFields(timing, { ...context, ...(repoFacts ? { repoFacts } : {}) })
  })
}
