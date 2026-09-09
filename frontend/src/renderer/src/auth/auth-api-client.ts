// HTTP client for web auth endpoints (CR-LOGIN-001 — SOL-FE-LG-001 §4.2)
// All requests carry credentials: 'include' so the server session cookie is
// sent automatically. No tokens are stored in localStorage.

import type { AuthUser } from './auth-types'
import { AuthError } from './auth-types'

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

/**
 * Check whether the browser currently has a valid session.
 * Returns the logged-in AuthUser, or null when the session is absent/expired.
 * Throws on network / 5xx errors.
 */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const res = await fetch('/auth/me', { credentials: 'include' })
  if (res.status === 401) {
    return null
  }
  if (!res.ok) {
    throw new Error(`Server error: ${res.status}`)
  }
  return res.json() as Promise<AuthUser>
}

// ─── POST /auth/local ─────────────────────────────────────────────────────────

/**
 * Authenticate with email + password.
 * On success the server sets a session cookie and returns the user payload.
 * Throws AuthError(code='invalid_credentials') on 401.
 */
export async function loginLocal(email: string, password: string): Promise<AuthUser> {
  const res = await fetch('/auth/local', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new AuthError((body as { error?: string }).error ?? 'Login failed', 'invalid_credentials')
  }
  return body as AuthUser
}

// ─── POST /auth/logout ────────────────────────────────────────────────────────

/**
 * Invalidate the current session cookie on the server.
 * Non-fatal if the session is already gone (we swallow non-network errors).
 */
export async function logoutUser(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' })
}

// ─── POST /auth/refresh ─────────────────────────────────────────────────────
// CR-RBAC-003: rotation — server issue session mới, revoke session cũ. Trả
// null khi session đã bị revoke/hết hạn quá hạn refresh (403) — không throw,
// để caller quyết định logout thay vì crash UI.
export async function refreshSession(): Promise<AuthUser | null> {
  const res = await fetch('/auth/refresh', { method: 'POST', credentials: 'include' })
  if (res.status === 403 || res.status === 401) {
    return null
  }
  if (!res.ok) {
    throw new Error(`Server error: ${res.status}`)
  }
  return res.json() as Promise<AuthUser>
}

// ─── GET /auth/config ─────────────────────────────────────────────────────────

/**
 * Fetch which SSO providers and local-password login are enabled on this
 * deployment.  Falls back to "local only" on any error so the login page
 * always renders something.
 */
export async function fetchAuthConfig(): Promise<{
  providers: string[]
  localEnabled: boolean
}> {
  try {
    const res = await fetch('/auth/config', { credentials: 'include' })
    if (!res.ok) {
      return { providers: [], localEnabled: true }
    }
    return res.json()
  } catch {
    return { providers: [], localEnabled: true }
  }
}
