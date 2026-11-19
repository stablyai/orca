// Keeps Connect Linear's login usable: Linear's access tokens last 24 hours, and a PKCE login
// refreshes with the app's client id alone. Each refresh rotates the refresh token too.
import {
  createHostOAuthRefresher,
  defaultHostOAuthRefreshDeps,
  type HostOAuthRefreshDeps
} from '../../host-oauth/host-oauth-refresh'
import { getWorkspaceFile } from './linear-workspace-registry'
import {
  clearWorkspaceLogin,
  hasWorkspaceLogin,
  readWorkspaceLogin,
  saveWorkspaceLogin,
  type LinearLogin
} from './linear-login-store'

const refresher = createHostOAuthRefresher<LinearLogin>({
  tokenUrl: 'https://api.linear.app/oauth/token',
  refreshAheadMs: 60 * 60_000,
  rotates: true,
  read: readWorkspaceLogin,
  grantOf: (login) => login,
  save: (workspaceId, login, refreshed) =>
    saveWorkspaceLogin(workspaceId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      clientId: login.clientId
    }),
  // Revoked or expired for good: forget it, so Orca says to connect again instead of failing.
  // Offline needs nothing: the next read or wake tries again; Linear replays a refresh for 30 minutes.
  ended: (workspaceId) => clearWorkspaceLogin(workspaceId)
})

/**
 * Refreshes one workspace's login when it is due, or now when Linear refused it (force);
 * concurrent callers share one refresh.
 */
export async function refreshLinearLogin(
  workspaceId: string,
  deps: HostOAuthRefreshDeps = defaultHostOAuthRefreshDeps,
  force = false
): Promise<void> {
  await refresher.refresh(workspaceId, deps, force)
}

/** Every saved login that is due, e.g. at startup and when the Mac wakes. */
export async function refreshDueLinearLogins(
  deps: HostOAuthRefreshDeps = defaultHostOAuthRefreshDeps
): Promise<void> {
  const ids = getWorkspaceFile()
    .workspaces.map((workspace) => workspace.id)
    .filter(hasWorkspaceLogin)
  await Promise.all(ids.map((id) => refreshLinearLogin(id, deps)))
}

/** Starts a refresh in the background when the login just read is near its end. */
export function refreshLinearLoginIfDue(workspaceId: string, login: LinearLogin): void {
  if (refresher.isDue(login, Date.now())) {
    refreshLinearLogin(workspaceId).catch((error: unknown) =>
      console.warn('[linear] login refresh failed', error)
    )
  }
}
