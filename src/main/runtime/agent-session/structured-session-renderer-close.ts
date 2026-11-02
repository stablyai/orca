import { SESSION_TAB_NOT_FOUND_ERROR } from '../../../shared/session-tab-close'

/** A renderer that already removed the captured tab has acknowledged the close. */
export async function closeRenderedStructuredSessionTab(
  notifier:
    | { closeSessionTab?: (tabId: string, worktreeId: string) => void | Promise<unknown> }
    | null
    | undefined,
  tabId: string,
  worktreeId: string
): Promise<void> {
  if (notifier?.closeSessionTab) {
    try {
      await notifier.closeSessionTab(tabId, worktreeId)
    } catch (error) {
      if (!(error instanceof Error && error.message === SESSION_TAB_NOT_FOUND_ERROR)) {
        throw error
      }
    }
  }
}
