// UsersTab + its CreateUserForm — split out of AdminOrgConsole.tsx (AGENTS.md
// max-lines budget). CreateUserForm is shared by UsersTab (the common "add a
// teammate" case, tenantId defaults to the caller's own company) and
// CompanyTab (bootstrap a brand-new company's first admin, tenantId fixed to
// that company) — see admin-org-console-company-tab.tsx's import of it.
//
// "Create user" required fixing a real gap first: auth-service's CreateUser
// used to always generate a random, never-returned password (no invite/reset-
// link flow exists), so a created account could never log in. Fixed at the
// source (CreateUserRequest now accepts an optional admin-supplied password,
// and returns the generated one exactly once when none is supplied) rather
// than left unexposed.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { toast } from 'sonner'
import type { AdminUser, AdminUserRole } from '../../../../shared/admin-user-types'
import { useDepartments } from './admin-org-console-shared'
import { UserSessionsPanel } from './admin-org-console-sessions-tab'

export function CreateUserForm(props: {
  fixedTenantId?: string
  onCreated: () => void
}): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<AdminUserRole>('user')
  const [password, setPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null)

  const canSubmit = email.trim().length > 0 && name.trim().length > 0

  const handleCreate = useCallback(() => {
    if (!canSubmit || creating) {
      return
    }
    setCreating(true)
    setGeneratedPassword(null)
    window.api.admin
      .createUser({
        email: email.trim(),
        name: name.trim(),
        role,
        tenantId: props.fixedTenantId,
        password: password.trim() || undefined
      })
      .then((result) => {
        setEmail('')
        setName('')
        setPassword('')
        setRole('user')
        if (result.generatedPassword) {
          setGeneratedPassword(result.generatedPassword)
        }
        toast.success('User created')
        props.onCreated()
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreating(false))
  }, [canSubmit, creating, email, name, role, password, props])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email@company.com"
          className="w-56"
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          className="w-44"
        />
        <Select value={role} onValueChange={(v) => setRole(v as AdminUserRole)}>
          <SelectTrigger className="h-9 w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="user">user</SelectItem>
            <SelectItem value="admin">admin</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password (optional — auto-generated if blank)"
          className="w-64"
        />
        <Button disabled={!canSubmit || creating} onClick={handleCreate}>
          {creating ? 'Creating…' : 'Create user'}
        </Button>
      </div>
      {generatedPassword ? (
        <div className="rounded-md border border-border bg-muted/50 p-3 text-sm">
          <p className="font-medium text-foreground">
            One-time password — copy it now, it will not be shown again:
          </p>
          <code className="mt-1 block select-all rounded bg-background px-2 py-1">
            {generatedPassword}
          </code>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        No invite email exists yet — you&apos;re responsible for sharing the password with the new
        user yourself.
      </p>
    </div>
  )
}

export function UsersTab(): React.JSX.Element {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const { departments } = useDepartments()
  const [departmentChoice, setDepartmentChoice] = useState<Record<string, string>>({})
  // FE-TASK-021: Sessions panel is opened per-row (backend has no
  // cross-user "list all sessions" RPC), not a standalone tab.
  const [sessionsPanelUserId, setSessionsPanelUserId] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    window.api.admin
      .listUsers()
      .then((result) => setUsers(result.users))
      .catch(() => toast.error('Failed to load users'))
      .finally(() => setLoading(false))
  }, [reloadToken])

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  const handleRoleChange = useCallback(
    (userId: string, role: AdminUserRole) => {
      setBusyId(userId)
      window.api.admin
        .updateUserRole({ userId, role })
        .then(() => {
          reload()
          toast.success('Role updated')
        })
        .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusyId(null))
    },
    [reload]
  )

  const handleActiveToggle = useCallback(
    (user: AdminUser) => {
      setBusyId(user.id)
      const action = user.isActive
        ? window.api.admin.deactivateUser
        : window.api.admin.reactivateUser
      action({ userId: user.id })
        .then(() => reload())
        .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusyId(null))
    },
    [reload]
  )

  const handleDepartmentAssign = useCallback(
    (userId: string) => {
      const departmentId = departmentChoice[userId]
      if (!departmentId) {
        return
      }
      setBusyId(userId)
      window.api.tenantProfile
        .setUserDepartmentFor({ userId, departmentId })
        .then(() => {
          toast.success('Department assigned')
          // Why: admin.listUsers is the only source that shows a user's
          // CURRENT department (see userView.departmentId's doc comment) —
          // without reloading, the Select kept showing the locally-picked
          // value from departmentChoice, which reset on refresh and made a
          // successful assign look like it had silently reverted.
          setDepartmentChoice((prev) => {
            const next = { ...prev }
            delete next[userId]
            return next
          })
          reload()
        })
        .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusyId(null))
    },
    [departmentChoice, reload]
  )

  if (loading && users.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  return (
    <div className="flex flex-col gap-4">
      <CreateUserForm onCreated={reload} />
      <div className="flex flex-col gap-3">
        {users.map((user) => (
          <div key={user.id} className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{user.name || user.email}</p>
                <p className="text-xs text-muted-foreground">{user.email}</p>
              </div>
              <Badge variant={user.isActive ? 'default' : 'destructive'}>
                {user.isActive ? 'active' : 'deactivated'}
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={user.role}
                onValueChange={(value) => handleRoleChange(user.id, value as AdminUserRole)}
                disabled={busyId === user.id}
              >
                <SelectTrigger className="h-8 w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">user</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>

              <Select
                // Why: falls back to the user's actually-persisted department
                // (user.departmentId) whenever there's no unsaved local pick —
                // otherwise this always showed the placeholder after a reload,
                // looking like a successful assign had silently reverted.
                value={departmentChoice[user.id] ?? user.departmentId ?? ''}
                onValueChange={(value) =>
                  setDepartmentChoice((prev) => ({ ...prev, [user.id]: value }))
                }
                disabled={busyId === user.id}
              >
                <SelectTrigger className="h-8 w-[200px]">
                  <SelectValue placeholder="Assign department" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((dept) => (
                    <SelectItem key={dept.id} value={dept.id}>
                      {dept.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={!departmentChoice[user.id] || busyId === user.id}
                onClick={() => handleDepartmentAssign(user.id)}
              >
                Assign
              </Button>

              <Button
                size="sm"
                variant={user.isActive ? 'outline' : 'secondary'}
                disabled={busyId === user.id}
                onClick={() => handleActiveToggle(user)}
              >
                {user.isActive ? 'Deactivate' : 'Reactivate'}
              </Button>

              <Button size="sm" variant="ghost" onClick={() => setSessionsPanelUserId(user.id)}>
                View sessions
              </Button>
            </div>
          </div>
        ))}
        {users.length === 0 ? (
          <p className="text-sm text-muted-foreground">No users found.</p>
        ) : null}
      </div>
      {sessionsPanelUserId ? (
        <UserSessionsPanel
          userId={sessionsPanelUserId}
          userLabel={
            users.find((u) => u.id === sessionsPanelUserId)?.name ??
            users.find((u) => u.id === sessionsPanelUserId)?.email ??
            sessionsPanelUserId
          }
          open={sessionsPanelUserId !== null}
          onOpenChange={(open) => {
            if (!open) {
              setSessionsPanelUserId(null)
            }
          }}
        />
      ) : null}
    </div>
  )
}
