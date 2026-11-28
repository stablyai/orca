import {
  SESSION_TAB_NOT_FOUND_ERROR,
  type SessionTabCloseStage
} from '../../../../shared/workspace-layout/client-views/session-tab-close'

type SessionTabCloseNotifier =
  | {
      closeSessionTab?: (
        tabId: string,
        worktreeId: string,
        stage?: { stage: SessionTabCloseStage; error?: string }
      ) => void | Promise<unknown>
    }
  | null
  | undefined

/** A renderer that already removed the captured tab has acknowledged the close. */
export async function closeRenderedStructuredSessionTab(
  notifier: SessionTabCloseNotifier,
  tabId: string,
  worktreeId: string,
  stage?: { stage: SessionTabCloseStage; error?: string }
): Promise<void> {
  if (notifier?.closeSessionTab) {
    try {
      await notifier.closeSessionTab(tabId, worktreeId, stage)
    } catch (error) {
      if (!(error instanceof Error && error.message === SESSION_TAB_NOT_FOUND_ERROR)) {
        throw error
      }
    }
  }
}

/** The window confirms the close and keeps the tab; `close` then runs the host close, and the tab
 *  leaves only when it landed. A failed close keeps the tab and shows why. */
export async function closeRenderedStructuredSessionTabAround(
  notifier: SessionTabCloseNotifier,
  tabId: string,
  worktreeId: string,
  close: () => Promise<boolean>
): Promise<boolean> {
  await closeRenderedStructuredSessionTab(notifier, tabId, worktreeId, { stage: 'confirm' })
  let closed = false
  let failure: unknown
  try {
    closed = await close()
  } catch (error) {
    failure = error
  }
  const error = failure instanceof Error ? failure.message : failure ? String(failure) : undefined
  await closeRenderedStructuredSessionTab(
    notifier,
    tabId,
    worktreeId,
    closed ? { stage: 'drop' } : { stage: 'failed', ...(error ? { error } : {}) }
  ).catch((notifyError: unknown) =>
    console.warn('[structured-agent-session] settling a chat tab close failed', notifyError)
  )
  if (failure !== undefined) {
    throw failure
  }
  return closed
}
