// AdminOrgConsole.tsx — org administration: departments + user management.
// Companion to AdminDevServerConsole.tsx (dev-server approval/grouping) —
// kept separate since this covers a different domain (tenant-service
// departments, auth-service users), found live to have ZERO UI anywhere
// (CR-DS-006/007/008 follow-up: an admin had no way to create a department
// or see/manage any other user, which is why "Grant a department access"
// always showed an empty picker).
//
// Split into per-tab files (company/departments/users, AGENTS.md max-lines
// budget) — this file only wires the three tabs together; see
// admin-org-console-company-tab.tsx, admin-org-console-departments-tab.tsx,
// admin-org-console-users-tab.tsx, and the shared admin-org-console-shared.ts
// (useDepartments) for the actual tab implementations.
import { Building2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { CompanyTab } from './admin-org-console-company-tab'
import { DepartmentsTab } from './admin-org-console-departments-tab'
import { UsersTab } from './admin-org-console-users-tab'
import { TeamsTab } from './admin-org-console-teams-tab'
import { PoliciesTab } from './admin-org-console-policies-tab'
import { AuditTab } from './admin-org-console-audit-tab'

export function AdminOrgConsole(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-base font-semibold">
          {translate('auto.components.settings.AdminOrgConsole.title', 'Organization')}
        </h2>
      </div>
      <p className="text-sm text-muted-foreground">
        {translate(
          'auto.components.settings.AdminOrgConsole.description',
          'Manage your company, departments, and user accounts.'
        )}
      </p>
      <Tabs defaultValue="company">
        <TabsList>
          <TabsTrigger value="company">Company</TabsTrigger>
          <TabsTrigger value="departments">Departments</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>
        <TabsContent value="company">
          <CompanyTab />
        </TabsContent>
        <TabsContent value="departments">
          <DepartmentsTab />
        </TabsContent>
        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="teams">
          <TeamsTab />
        </TabsContent>
        <TabsContent value="policies">
          <PoliciesTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
