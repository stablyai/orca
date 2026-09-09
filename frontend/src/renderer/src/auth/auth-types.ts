// Auth types for web login layer (CR-LOGIN-001)
// Note: OrcaUser / OrcaUserRole are re-exported from store/slices/auth.ts for
// cross-slice consumers. These types are the *HTTP-layer* view used by
// auth-api-client and the login page components.

export type SsoProvider = 'github' | 'google' | 'keycloak'

/**
 * Shape returned by GET /auth/me and POST /auth/local.
 * Kept intentionally flat — components only need what the API returns.
 */
export type AuthUser = {
  id: string
  email: string
  name: string
  role: 'developer' | 'admin' // was: 'developer' | 'lead' | 'admin'
  /** OAuth provider used to authenticate, or 'none' for local-password accounts */
  provider: 'none' | SsoProvider
  avatarUrl?: string
}

/**
 * Discriminated union tracking session state in AuthSlice.
 * 'unknown'       — bootstrap has not yet called GET /auth/me
 * 'unauthenticated' — no valid session
 * 'authenticated' — session cookie is valid; user is populated
 * 'error'         — network/server error during session check
 */
export type AuthState =
  | { status: 'unknown' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'error'; message: string }

/** Thrown by auth-api-client when the server rejects credentials. */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'AuthError'
  }
}
