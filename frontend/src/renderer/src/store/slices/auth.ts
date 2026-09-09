// AuthSlice — user identity and authentication state (CR-006, TASK-006-B, CR-LOGIN-001)
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

// ─── Types ────────────────────────────────────────────────────────────────────

// CR-RBAC-002: backend thật (auth-service) chỉ có 2 role toàn cục (user/admin,
// roleToString ở api-gateway map non-admin → "developer" cho tương thích UI cũ)
// — "lead" chưa từng tồn tại được cho user thật nào. "lead" đúng nghĩa chỉ ở
// RepoRole (theo từng repo, xem RepoMemberManager.tsx), không phải role toàn cục.
export type OrcaUserRole = 'developer' | 'admin'

export type OrcaUser = {
  id: string
  email: string
  name: string
  avatarUrl?: string
  role: OrcaUserRole
  // teams/projects: xoá — không nguồn nào đổ dữ liệu thật (CR-RBAC-004);
  // scoping RBAC thật là infra-fleet-service's Department/Team grant, không
  // phải field này trên OrcaUser.
}

export type AuthStatus =
  | 'unknown' // bootstrap has not yet called GET /auth/me
  | 'unauthenticated'
  | 'authenticating'
  | 'authenticated'
  | 'error'

export type AuthSlice = {
  currentUser: OrcaUser | null
  authStatus: AuthStatus
  authError: string | null

  setCurrentUser: (user: OrcaUser | null) => void
  setAuthStatus: (status: AuthStatus, error?: string) => void
  clearAuth: () => void
  /** Check the current session by calling GET /auth/me and update store. */
  checkSession: () => Promise<void>
}

// ─── Slice Factory ────────────────────────────────────────────────────────────

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (set) => ({
  currentUser: null,
  authStatus: 'unknown', // unknown until bootstrap resolves
  authError: null,

  setCurrentUser: (user) => set(() => ({ currentUser: user })),

  setAuthStatus: (status, error) => set(() => ({ authStatus: status, authError: error ?? null })),

  clearAuth: () =>
    set(() => ({
      currentUser: null,
      authStatus: 'unauthenticated',
      authError: null
    })),

  checkSession: async () => {
    // Why lazy import: avoids circular dependency between store ↔ auth-api-client
    const { fetchCurrentUser } = await import('../../auth/auth-api-client')
    set(() => ({ authStatus: 'authenticating', authError: null }))
    try {
      const user = await fetchCurrentUser()
      if (user) {
        // Map AuthUser (HTTP layer) → OrcaUser (store layer)
        set(() => ({
          authStatus: 'authenticated',
          authError: null,
          currentUser: {
            id: user.id,
            email: user.email,
            name: user.name,
            avatarUrl: user.avatarUrl,
            role: user.role
          }
        }))
      } else {
        set(() => ({ authStatus: 'unauthenticated', authError: null, currentUser: null }))
      }
    } catch (err) {
      set(() => ({
        authStatus: 'error',
        authError: (err as Error).message,
        currentUser: null
      }))
    }
  }
})
