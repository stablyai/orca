// TASK-FE-014: AdminApp — root component of the Admin SPA.
// Uses prop-driven state routing (no react-router-dom). Pages are loaded lazily.
//
// CR-RBAC-001/FE-TASK-023 (2026-09-11): trimmed down to Fleet/AI Providers/
// Profile only — Users/Policies/Sessions/Audit Log/Teams/the Dashboard
// landing page (all backed by admin-api-client.ts / callRuntimeRpc('team.*'),
// legacy transports this CR retires) were deleted, fully replaced by
// Settings' AdminOrgConsole. Fleet/AI Providers/Profile stay: FE-TASK-024
// confirmed they are distinct features with no equivalent (and no other
// mount point) anywhere else in the app — see AdminLayout.tsx's doc comment
// for the full reasoning. `/fleet` is now the default route (there is no
// more "/" dashboard to land on).
import { useState, Suspense, lazy } from 'react'
import { AdminLayout, type AdminRoute } from './AdminLayout'
import { useAuthUser } from '../../hooks/useAuthSession'
import { useLogout } from '../../hooks/useLogout'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

// Lazy-load each page to keep the initial bundle small
const CompanyProfileAdmin = lazy(() =>
  import('../profile/CompanyProfileAdmin').then((m) => ({ default: m.CompanyProfileAdmin }))
)
const DeptProfileAdmin = lazy(() =>
  import('../profile/DeptProfileAdmin').then((m) => ({ default: m.DeptProfileAdmin }))
)
const ProviderList = lazy(() =>
  import('../ai-provider/ProviderList').then((m) => ({ default: m.ProviderList }))
)
const FleetDashboard = lazy(() =>
  import('./fleet/fleet-dashboard').then((m) => ({ default: m.FleetDashboard }))
)

// TASK-FE-014: /profile hosts both company-wide and per-department profile
// admin — DeptProfileAdmin was never mounted anywhere, so it's exposed here
// as a tab rather than a new AdminRoute (keeps AdminLayout's route table untouched).
function ProfileAdminPage() {
  const [tab, setTab] = useState<'company' | 'departments'>('company')
  return (
    <div className="profile-admin-page">
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'company' | 'departments')}>
        <TabsList>
          <TabsTrigger value="company">Company</TabsTrigger>
          <TabsTrigger value="departments">Departments</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'company' ? <CompanyProfileAdmin /> : <DeptProfileAdmin />}
    </div>
  )
}

function PageContent({ route }: { route: AdminRoute }) {
  if (route === '/profile') {
    return <ProfileAdminPage />
  }
  if (route === '/ai-providers') {
    return <ProviderList />
  }
  return <FleetDashboard />
}

export function AdminApp() {
  const [currentRoute, setCurrentRoute] = useState<AdminRoute>('/fleet')
  const user = useAuthUser()
  const logout = useLogout()

  // Guard: if not authenticated, this shouldn't render (backend redirects to /login)
  if (!user) {
    return (
      <div className="admin-auth-guard">
        <p>Not authenticated. Redirecting…</p>
      </div>
    )
  }

  return (
    <AdminLayout
      currentRoute={currentRoute}
      onNavigate={(r) => setCurrentRoute(r as AdminRoute)}
      userEmail={user.email}
      onLogout={logout}
    >
      <Suspense
        fallback={
          <div className="admin-page-loading" aria-label="Loading page…">
            Loading…
          </div>
        }
      >
        <PageContent route={currentRoute} />
      </Suspense>
    </AdminLayout>
  )
}
