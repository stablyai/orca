// TASK-FE-009: useLogout hook
// Encapsulates the full logout sequence: POST /auth/logout → clear browser state → redirect.
import { useCallback } from 'react'
import { useAppStore } from '../store'
import { logoutUser } from '../auth/auth-api-client'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import { translate } from '../i18n/i18n'

/**
 * Clear all cookies for the current domain (all paths).
 * Handles cookies set with path=/ as well as path-scoped ones.
 */
function clearAllCookies(): void {
  const cookies = document.cookie.split(';')
  for (const cookie of cookies) {
    const name = cookie.split('=')[0].trim()
    if (!name) {
      continue
    }
    // Expire the cookie for common path variants
    const expire = 'expires=Thu, 01 Jan 1970 00:00:00 GMT'
    document.cookie = `${name}=; ${expire}; path=/`
    document.cookie = `${name}=; ${expire}; path=/; domain=${location.hostname}`
    document.cookie = `${name}=; ${expire}; path=/; domain=.${location.hostname}`
  }
}

// FE-TASK-STORAGE-016: proactively tear down every backend-go-tracked
// connection for the active runtime environment before the local session is
// wiped, so infra-fleet-service sees an explicit close (skips its
// disconnect grace-period, BE-SOL-STORAGE-003 §5) instead of inferring one
// from a dropped socket. `getActiveRuntimeTarget` reads `settings` directly
// off the store (not a hook selector) because this runs from inside an
// async callback, not render.
//
// UPDATE (2026-09-08): the wscompat channel 'connection.teardown' now
// exists for real — TASK-BE-STORAGE-012 Part C wired it in
// channels_infra_fleet.go, and Part D made infra-fleet-service also
// best-effort notify the live agent (TASK-AG-STORAGE-007's
// 'connection.teardown' inbound handler) to kill its PTYs immediately. This
// call site needed no changes — it was already written against the
// intended contract.
async function closeAllActiveSessions(): Promise<void> {
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  if (target.kind !== 'environment') {
    // Desktop-local target has no backend-go connectionId to tear down.
    return
  }
  const { connections } = useAppStore.getState()
  await Promise.allSettled(
    Object.keys(connections).map((connectionId) =>
      callRuntimeRpc(target, 'connection.teardown', { connectionId })
    )
  )
}

/**
 * Returns an async callback that fully logs out the current user.
 *
 * Sequence:
 *   0. Confirm with the user — logout closes every active terminal/agent
 *      session and forgets servers saved on this browser.
 *   1. POST /auth/logout  — invalidate server session
 *   2. closeAllActiveSessions() — explicitly tear down backend-go connections
 *   3. localStorage.clear()  — remove all persisted app state
 *   4. sessionStorage.clear() — remove all tab-scoped state
 *   5. clearAllCookies()  — expire all cookies (including stale session tokens)
 *   6. clearAuth()        — reset Zustand auth slice
 *   7. window.location.href = '/login'  — full page reload → clean state
 *
 * Step 1 is non-fatal: stale/missing sessions are handled gracefully. Step 2
 * uses Promise.allSettled so a slow/unreachable dev server can never block
 * logout.
 *
 * Confirmation uses `window.confirm` rather than the codebase's shared
 * `useConfirmationDialog` (components/confirmation-dialog.tsx): that dialog
 * throws when rendered outside its `ConfirmationDialogProvider`, and two of
 * this hook's real call sites — AdminApp.tsx and main-web-bootstrap.tsx's
 * WebConnectionBannerWrapper — mount outside that provider's tree, so
 * calling it unconditionally here would crash Logout there. Calling it
 * conditionally is not an option either: oxlint's react-hooks/rules-of-hooks
 * is error-level and forbids any conditional hook invocation (including
 * try/catch). See FE-TASK-STORAGE-016 report for the follow-up options.
 */
export function useLogout(): () => Promise<void> {
  const clearAuth = useAppStore((s) => s.clearAuth)

  return useCallback(async () => {
    // 0. Confirm — this closes active sessions and forgets saved servers.
    const confirmed = window.confirm(
      translate(
        'auto.hooks.useLogout.confirm',
        'Logging out will close all active terminal/agent sessions and forget servers saved on this browser. Continue?'
      )
    )
    if (!confirmed) {
      return
    }

    // 1. Invalidate server session (best-effort)
    try {
      await logoutUser()
    } catch {
      // Non-fatal: the server session may already be gone.
    }

    // 2. Explicitly tear down backend-go connections before local state is wiped.
    await closeAllActiveSessions()

    // 3–5. Purge all browser-side state
    try {
      localStorage.clear()
    } catch {
      /* sandboxed iframe: ignore */
    }
    try {
      sessionStorage.clear()
    } catch {
      /* sandboxed iframe: ignore */
    }
    clearAllCookies()

    // 6. Reset Zustand store
    clearAuth()

    // 7. Full-page redirect → ensures React re-mounts cleanly from scratch
    window.location.href = '/login'
  }, [clearAuth])
}
