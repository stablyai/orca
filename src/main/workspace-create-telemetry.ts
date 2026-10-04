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

/** One create's `workspace_created` / `workspace_create_failed` event: exactly one is sent. */
export type WorkspaceCreateTelemetry = {
  /** The recorder the create times its phases into. */
  readonly timing: WorktreeCreateTimingRecorder
  /** `timing` is the create's own finished timing when it returned one. */
  succeeded(timing?: WorktreeCreateTiming): void
  failed(error: unknown): void
}

export type WorkspaceCreateTelemetryArgs = {
  /** The caller-supplied value, validated here; anything else is sent as `unknown`. */
  source: unknown
  entryPoint: WorkspaceCreateEntryPoint
  repoPath: string
  fromExistingBranch: boolean
  /** Folder workspaces register a directory: no timing, no disk competition, event unchanged. */
  isFolder: boolean
}

/**
 * Starts the events for one create. Both create entry points (the app's IPC handler and the
 * runtime API) begin here, so a create is counted once and both send the same fields.
 */
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

/** Lets a runtime create start its events once it is known to be a Git create. */
export type RuntimeWorkspaceCreateEvents = {
  begin(repoPath: string): WorktreeCreateTimingRecorder
}

/**
 * Runs a runtime create and settles its events before returning, so a re-arm the caller fires
 * afterwards is not counted against it. Folder workspaces and requests rejected before `begin`
 * send nothing, as before.
 */
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

/** Runs after the create has returned, so the repo probe never adds to create latency. */
async function trackWorkspaceCreated(
  props: EventProps<'workspace_created'>,
  repoPath: string,
  timing: WorktreeCreateTiming,
  context: WorkspaceCreateEventContext
): Promise<void> {
  // SSH would need a remote round trip, so only local and WSL repos are probed; with telemetry
  // off the repo's .git is not read at all.
  const repoFacts =
    isTelemetryEnabled() && (timing.executionHost === 'local' || timing.executionHost === 'wsl')
      ? await probeCreateEventRepoFacts(repoPath)
      : undefined
  track('workspace_created', {
    ...props,
    ...workspaceCreateTimingFields(timing, { ...context, ...(repoFacts ? { repoFacts } : {}) })
  })
}
