import {
  SESSION_TAB_NOT_FOUND_ERROR,
  type SessionTabCloseStage
} from '../../../../shared/workspace-layout/client-views/session-tab-close'

type SessionTabCloseNotifier =
  | {
      closeSessionTab?: (
        tabId: string,
        worktreeId: string,
        stage?: SessionTabCloseStage
      ) => void | Promise<unknown>
    }
  | null
  | undefined

/** A renderer that already removed the captured tab has acknowledged the close. */
export async function closeRenderedStructuredSessionTab(
  notifier: SessionTabCloseNotifier,
  tabId: string,
  worktreeId: string,
  stage?: SessionTabCloseStage
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
 *  leaves only when it landed. A failed close keeps the tab. */
export async function closeRenderedStructuredSessionTabAround(
  notifier: SessionTabCloseNotifier,
  tabId: string,
  worktreeId: string,
  close: () => Promise<boolean>
): Promise<boolean> {
  await closeRenderedStructuredSessionTab(notifier, tabId, worktreeId, 'confirm')
  const closed = await close()
  if (closed) {
    await closeRenderedStructuredSessionTab(notifier, tabId, worktreeId, 'drop').catch(
      (error: unknown) =>
        console.warn('[structured-agent-session] dropping a closed chat tab failed', error)
    )
  }
  return closed
}
