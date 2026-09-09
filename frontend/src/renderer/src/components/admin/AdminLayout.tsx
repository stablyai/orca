// TASK-FE-014: AdminLayout — shell for the Admin SPA.
// Uses simple hash-based routing (no react-router-dom dependency required).
//
// CR-RBAC-001/FE-TASK-023 (2026-09-11): Users/Policies/Sessions/Audit Log/Teams
// were retired from here — those domains now live in Settings' AdminOrgConsole
// (backend-go-facing, see admin-org-console-*.tab.tsx), which fully replaces
// this SPA's equivalents. Fleet/AI Providers/Profile stay: FE-TASK-024 found
// they are NOT duplicates of anything in AdminOrgConsole/Settings (different
// features entirely — health-monitoring+CSV import, org-level AI provider
// accounts, and OrcaProfile model-default resolution, respectively — see that
// task's "Kết quả thực tế" for the full comparison) and have no other mount
// point in the app, so deleting this shell would have silently orphaned them.
// This SPA is intentionally kept alive, trimmed to just those 3, until a
// separate decision relocates them into Settings or confirms they can be
// dropped.
import type { ReactNode } from 'react'

export type AdminRoute = '/fleet' | '/ai-providers' | '/profile'

type Props = {
  currentRoute: AdminRoute
  onNavigate: (route: AdminRoute) => void
  userEmail: string
  onLogout: () => void
  children: ReactNode
}

type NavItem = { route: AdminRoute; label: string; icon: string; exact?: boolean }

const NAV_ITEMS: NavItem[] = [
  { route: '/fleet', label: 'Fleet', icon: '🖥️', exact: true },
  { route: '/ai-providers', label: 'AI Providers', icon: '🤖' },
  { route: '/profile', label: 'Profile', icon: '🏢' }
]

function isActive(item: NavItem, current: AdminRoute): boolean {
  if (item.exact) {
    return current === item.route
  }
  return current.startsWith(item.route)
}

export function AdminLayout({ currentRoute, onNavigate, userEmail, onLogout, children }: Props) {
  return (
    <div className="admin-layout">
      {/* Header */}
      <header className="admin-header">
        <span className="admin-header__logo">🔧 Orca Admin</span>
        <div className="admin-header__user">
          <span className="admin-header__email">{userEmail}</span>
          <button type="button" className="admin-header__logout" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      <div className="admin-body">
        {/* Sidebar nav */}
        <nav className="admin-nav" aria-label="Admin navigation">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.route}
              type="button"
              className={`admin-nav__item${isActive(item, currentRoute) ? ' admin-nav__item--active' : ''}`}
              aria-current={isActive(item, currentRoute) ? 'page' : undefined}
              onClick={() => onNavigate(item.route)}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* Page content */}
        <main className="admin-content">{children}</main>
      </div>
    </div>
  )
}
