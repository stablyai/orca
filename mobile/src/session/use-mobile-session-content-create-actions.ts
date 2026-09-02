import type { RpcFailure, RpcSuccess } from '../transport/types'
import { normalizeBrowserUrl } from '../browser/browser-url'
import { captureMobileFileMutationOwnership } from '../files/mobile-file-mutation-ownership'
import { isFileExistsErrorMessage } from './mobile-session-route-helpers'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionTerminalCreateActionsModel } from './use-mobile-session-terminal-create-actions'

export function useMobileSessionContentCreateActions(
  scope: MobileSessionTerminalCreateActionsModel
) {
  const {
    worktreeId,
    client,
    creatingBrowser,
    setCreatingBrowser,
    creatingMarkdown,
    setCreatingMarkdown,
    setCreateError,
    pendingBrowserFocusPageIdRef,
    handleCreateBrowserRef,
    browserScreencastSupportedRef,
    scheduleDelayedAction,
    showToast,
    fetchSessionTabs,
    fetchPendingBrowserSessionTabs
  } = scope
  async function handleCreateMarkdownNote() {
    if (!client || creatingMarkdown) {
      return
    }

    setCreatingMarkdown(true)
    setCreateError('')

    try {
      const worktree = `id:${worktreeId}`
      const mutationOwnership = await captureMobileFileMutationOwnership(client, worktree)
      for (let attempt = 1; attempt <= 100; attempt += 1) {
        const relativePath = attempt === 1 ? 'untitled.md' : `untitled-${attempt}.md`
        const createResponse = await client.sendRequest(
          'files.createFile',
          { worktree, relativePath, ...mutationOwnership },
          { timeoutMs: 15_000 }
        )
        if (!createResponse.ok) {
          const message = (createResponse as RpcFailure).error.message
          if (isFileExistsErrorMessage(message) && attempt < 100) {
            continue
          }
          throw new Error(message || 'Failed to create markdown note')
        }

        const openResponse = await client.sendRequest(
          'files.open',
          { worktree, relativePath },
          { timeoutMs: 15_000 }
        )
        if (!openResponse.ok) {
          throw new Error((openResponse as RpcFailure).error.message)
        }
        scheduleDelayedAction(() => void fetchSessionTabs(), 300)
        return
      }
      throw new Error('Unable to create untitled markdown note')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create markdown note'
      setCreateError(message)
      showToast(message, 1800)
    } finally {
      setCreatingMarkdown(false)
    }
  }

  async function handleCreateBrowser(rawUrl = 'about:blank'): Promise<boolean> {
    if (!client || creatingBrowser) {
      return false
    }
    // Why: read via ref so a tap before the capability probe resolves (or a stale callback) still sees the live value.
    if (browserScreencastSupportedRef.current !== true) {
      showToast('Desktop update required for mobile browser streaming', 1600)
      return false
    }
    const url = normalizeBrowserUrl(rawUrl)
    if (!url) {
      const message = 'Enter a valid URL'
      setCreateError(message)
      showToast(message, 1400)
      return false
    }

    setCreatingBrowser(true)
    setCreateError('')
    try {
      const response = await client.sendRequest(
        'browser.tabCreate',
        {
          worktree: `id:${worktreeId}`,
          url,
          // The user opened this tab (tapped HTML / address bar) → focus it.
          activate: true
        },
        { timeoutMs: 30_000 }
      )
      if (!response.ok) {
        throw new Error((response as RpcFailure).error.message)
      }
      // Focus the new browser tab once it syncs; refresh a few times since the desktop registers the tab asynchronously.
      const created = (response as RpcSuccess).result as { browserPageId?: string }
      if (created.browserPageId) {
        pendingBrowserFocusPageIdRef.current = created.browserPageId
      }
      void fetchSessionTabs()
      scheduleDelayedAction(() => void fetchPendingBrowserSessionTabs(), 400)
      scheduleDelayedAction(() => void fetchPendingBrowserSessionTabs(), 1200)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create browser'
      setCreateError(message)
      showToast(message, 1800)
      return false
    } finally {
      setCreatingBrowser(false)
    }
  }
  // Keep the ref at the latest handleCreateBrowser so a terminal URL tap always runs the current closure.
  handleCreateBrowserRef.current = handleCreateBrowser

  async function handleBrowserNavigationCommand(
    tab: Extract<MobileSessionTab, { type: 'browser' }>,
    method: 'browser.back' | 'browser.forward' | 'browser.reload'
  ) {
    if (!client || !tab.browserPageId) {
      showToast('Browser page is not available yet.', 1500)
      return
    }
    try {
      const response = await client.sendRequest(
        method,
        {
          worktree: `id:${worktreeId}`,
          page: tab.browserPageId
        },
        { timeoutMs: 15_000 }
      )
      if (!response.ok) {
        throw new Error((response as RpcFailure).error.message)
      }
      scheduleDelayedAction(() => void fetchSessionTabs(), 250)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Browser command failed'
      showToast(message, 1600)
    }
  }
  return {
    handleCreateMarkdownNote,
    handleCreateBrowser,
    handleBrowserNavigationCommand
  }
}

export type MobileSessionContentCreateActionsModel = MobileSessionTerminalCreateActionsModel &
  ReturnType<typeof useMobileSessionContentCreateActions>
