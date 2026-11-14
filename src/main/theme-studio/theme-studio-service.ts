import type { z } from 'zod'
import {
  applyThemeStudioPatch,
  type ThemeStudioMode,
  type ThemeStudioPatch
} from '../../shared/theme-studio/theme-studio-draft'
import type {
  ThemeStudioAdjustParams,
  ThemeStudioEditParams
} from '../../shared/rpc-contract/theme-studio/theme-studio-params'
import {
  assertAgentEditsAllowed,
  assertRevision,
  draftEndedByUser,
  ThemeStudioRateLimit
} from './theme-studio-guards'
import {
  createThemeStudioCore,
  REPORT_TIMEOUT_MS,
  THEME_STUDIO_CAPABILITIES,
  type ThemeStudioCaller,
  type ThemeStudioServiceDeps
} from './theme-studio-core'
import { adjustDraft, applyDraft, checkDraft, editDraft, stepDraft } from './theme-studio-changes'

export type {
  ThemeStudioCaller,
  ThemeStudioMutation,
  ThemeStudioServiceDeps,
  ThemeStudioWindow
} from './theme-studio-core'

/** `orca theme` on this host: every change is queued, guarded, undoable and reported. */
export function createThemeStudioService(deps: ThemeStudioServiceDeps) {
  const core = createThemeStudioCore(deps)
  const { session, requireWindow } = core
  const rateLimit = new ThemeStudioRateLimit()
  // Why one queue: two agents (or a burst) must not both start a draft or interleave a fix loop.
  let queue: Promise<unknown> = session.ready
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  /** Every agent change: within its rate, allowed, on the revision it read, not after the person
   *  ended the draft. `starts` (edit) may begin anew; `cleanup` (discard) works even when off. */
  const agentChange = <T>(
    caller: ThemeStudioCaller,
    work: () => Promise<T>,
    options: { starts?: boolean; cleanup?: boolean } = {}
  ): Promise<T> => {
    // Why before the queue: a runaway caller is told at once instead of after everyone ahead.
    rateLimit.take(caller.key)
    return exclusive(async () => {
      if (!options.cleanup) {
        assertAgentEditsAllowed(deps.agentEditsAllowed())
      }
      requireWindow()
      const ended = session.endedByUserReason
      if (ended && !options.starts && !options.cleanup) {
        throw draftEndedByUser(ended)
      }
      // Why any step, saved ones too: a stale undo would otherwise change the selected themes.
      if (session.current) {
        assertRevision(caller.ifRevision, session.currentRevision)
      }
      return work()
    })
  }
  return {
    async status(options: { resolved: boolean; report: boolean }) {
      await session.ready
      const window = deps.window()
      const resolved = options.resolved && window ? await window.resolve() : undefined
      const status = session.status()
      const draft = session.draft
      const report =
        options.report && draft && window
          ? await session.waitForReport(REPORT_TIMEOUT_MS)
          : undefined
      return {
        ...status,
        draft,
        hasWindow: window !== null,
        agentEditsAllowed: deps.agentEditsAllowed(),
        capabilities: THEME_STUDIO_CAPABILITIES,
        ...(resolved ? { resolved } : {}),
        // Why the revision check: an edit that landed meanwhile has its own report.
        ...(report !== undefined
          ? { report: report?.revision === status.revision ? report : null }
          : {})
      }
    },
    edit: (params: z.infer<typeof ThemeStudioEditParams>, caller: ThemeStudioCaller) =>
      agentChange(caller, () => editDraft(core, params, caller), { starts: true }),
    patch: (change: ThemeStudioPatch, label: string, caller: ThemeStudioCaller) =>
      agentChange(caller, async () => {
        const { changed } = await core.commitChange(caller, label, (draft) =>
          applyThemeStudioPatch(draft, change)
        )
        return core.mutation(label, { changed })
      }),
    adjust: (params: z.infer<typeof ThemeStudioAdjustParams>, caller: ThemeStudioCaller) =>
      agentChange(caller, () => adjustDraft(core, params, caller)),
    check: (fix: boolean, ids: readonly string[] | undefined, caller: ThemeStudioCaller) =>
      agentChange(caller, () => checkDraft(core, fix, ids, caller)),
    step: (direction: 'undo' | 'redo', caller: ThemeStudioCaller) =>
      agentChange(caller, () => stepDraft(core, direction)),
    reset: (caller: ThemeStudioCaller) =>
      agentChange(caller, async () => {
        const start = session.start
        session.requireDraft()
        if (!start) {
          return core.mutation('Reset')
        }
        session.commit(start, 'Reset to the start', caller.by)
        return core.mutation('Reset to the start')
      }),
    shot: (mode: ThemeStudioMode | undefined) =>
      exclusive(async () => {
        const window = core.requireWindow()
        if (session.draft) {
          await session.waitForReport(REPORT_TIMEOUT_MS)
        }
        return { draft: session.draft !== null, ...(await window.capture(mode)) }
      }),
    apply: (name: string | undefined, caller: ThemeStudioCaller) =>
      agentChange(caller, () => applyDraft(core, name, caller.by)),
    discard: (caller: ThemeStudioCaller) =>
      agentChange(
        caller,
        async () => {
          const status = session.status()
          session.end('agent')
          return { discarded: status.active, name: status.name }
        },
        { cleanup: true }
      ),
    /** The person acted on the notice for `revision`, or picked a theme in Settings; a newer
     *  draft is left alone, and a failed Keep shows the notice again. */
    actFromWindow: (action: 'keep' | 'undo' | 'discard', revision: number): Promise<void> =>
      exclusive(async () => {
        if (!session.draft) {
          return
        }
        // Why only keep and undo check the revision: they act on what the person saw; Discard is
        // the kill switch and must win even while an agent keeps changing the draft.
        if (action === 'discard') {
          session.end('user', 'discarded it')
          return
        }
        if (revision !== session.currentRevision) {
          session.repaint()
          return
        }
        if (action === 'undo') {
          await stepDraft(core, 'undo')
        } else {
          await applyDraft(core, undefined, 'you')
          session.end('user', 'kept it')
        }
      }).catch((error: unknown) => {
        console.warn('[theme-studio] could not act on the draft:', error)
        session.repaint()
      }),
    /** Settings changed: the person picked a theme, or turned agent edits off. */
    settingsChanged: (change: { slots: boolean; agentEditsOff: boolean }): Promise<void> => {
      // Why decided now: the studio's own slot writes land while it awaits inside the queue.
      if (core.isWritingSlots() && !change.agentEditsOff) {
        return Promise.resolve()
      }
      return exclusive(async () => {
        if (!session.draft) {
          return
        }
        if (change.agentEditsOff) {
          session.end('user', 'turned off agent theme edits')
        } else if (change.slots) {
          session.end('user', 'picked another theme in Settings')
        }
      })
    }
  }
}

export type ThemeStudioService = ReturnType<typeof createThemeStudioService>
