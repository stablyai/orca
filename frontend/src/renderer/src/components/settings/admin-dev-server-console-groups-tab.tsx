// GroupsAndGrantsTab — split out of AdminDevServerConsole.tsx (AGENTS.md
// max-lines budget, exceeded after FE-TASK-012/CR-RBAC-004 added the
// team-grant picker alongside the existing department picker). Depends on
// AdminDevServerConsole.tsx's exported `useDevServerGroups` hook (also used
// by that file's own AccessRequestsTab, so it stays there as the single
// source of truth rather than being duplicated here).
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
import type { DevServerGroupGrant, DevServerGranteeKind } from '../../../../shared/dev-server-types'
import type { TenantDepartment, TenantTeam } from '../../../../shared/tenant-user-profile-types'
import { useDevServerGroups } from './AdminDevServerConsole'

export function GroupsAndGrantsTab(): React.JSX.Element {
  const { groups, loading, reload } = useDevServerGroups()
  const [departments, setDepartments] = useState<TenantDepartment[]>([])
  const [teams, setTeams] = useState<TenantTeam[]>([])
  const [newGroupName, setNewGroupName] = useState('')
  const [creating, setCreating] = useState(false)
  // Holds both kind and id, since a single group can now grant access to a
  // department AND a team (FE-TASK-012, CR-RBAC-004) via two independent
  // Selects below rather than one Select assumed to always mean 'department'.
  const [grantChoice, setGrantChoice] = useState<
    Record<string, { kind: DevServerGranteeKind; id: string } | undefined>
  >({})
  const [grantsByGroup, setGrantsByGroup] = useState<Record<string, DevServerGroupGrant[]>>({})

  useEffect(() => {
    window.api.tenantProfile
      .listDepartments()
      .then(setDepartments)
      .catch(() => {})
    // CR-RBAC-004: team.list wscompat channel is confirmed wired
    // (backend-go/.../wscompat/channels_team.go registered via
    // RegisterRealChannels) but the frontend web-preload-api.ts bridge for
    // tenantProfile.listTeams is not implemented yet (out of this task's
    // file scope — see FE-TASK-011's "Kết quả thực tế"). Until that bridge
    // exists this call resolves undefined/rejects and the catch below keeps
    // `teams` empty — the Select still renders, just without options.
    window.api.tenantProfile
      .listTeams?.()
      .then(setTeams)
      .catch(() => {})
  }, [])

  const loadGrants = useCallback((groupId: string) => {
    window.api.devServerGroup
      .listGrants(groupId)
      .then((grants) => setGrantsByGroup((prev) => ({ ...prev, [groupId]: grants })))
      .catch(() => toast.error('Failed to load grants'))
  }, [])

  useEffect(() => {
    groups.forEach((group) => loadGrants(group.id))
  }, [groups, loadGrants])

  const handleCreateGroup = useCallback(() => {
    if (!newGroupName.trim() || creating) {
      return
    }
    setCreating(true)
    window.api.devServerGroup
      .create({ name: newGroupName.trim() })
      .then(() => {
        setNewGroupName('')
        reload()
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreating(false))
  }, [newGroupName, creating, reload])

  const handleGrant = useCallback(
    (groupId: string) => {
      const choice = grantChoice[groupId]
      if (!choice) {
        return
      }
      window.api.devServerGroup
        .grant({ devServerGroupId: groupId, granteeKind: choice.kind, granteeId: choice.id })
        .then(() => loadGrants(groupId))
        .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
    },
    [grantChoice, loadGrants]
  )

  const handleRevoke = useCallback(
    (groupId: string, grantId: string) => {
      window.api.devServerGroup
        .revoke(grantId)
        .then(() => loadGrants(groupId))
        .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
    },
    [loadGrants]
  )

  const granteeName = useCallback(
    (kind: DevServerGranteeKind, id: string) =>
      kind === 'department'
        ? (departments.find((d) => d.id === id)?.name ?? id)
        : (teams.find((t) => t.id === id)?.name ?? id),
    [departments, teams]
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end gap-2">
        <Input
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          placeholder="New group name"
          className="max-w-xs"
        />
        <Button disabled={!newGroupName.trim() || creating} onClick={handleCreateGroup}>
          Create group
        </Button>
      </div>

      {loading && groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.id} className="rounded-lg border border-border p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">{group.name}</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                {(grantsByGroup[group.id] ?? []).map((grant) => (
                  <Badge key={grant.id} variant="secondary" className="gap-1">
                    {grant.granteeKind}: {granteeName(grant.granteeKind, grant.granteeId)}
                    <button
                      type="button"
                      className="ml-1 text-muted-foreground hover:text-foreground"
                      onClick={() => handleRevoke(group.id, grant.id)}
                      aria-label={`Revoke grant ${grant.id}`}
                    >
                      ×
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Select
                  value={
                    grantChoice[group.id]?.kind === 'department' ? grantChoice[group.id]!.id : ''
                  }
                  onValueChange={(value) =>
                    setGrantChoice((prev) => ({
                      ...prev,
                      [group.id]: { kind: 'department', id: value }
                    }))
                  }
                >
                  <SelectTrigger className="h-8 w-[220px]">
                    <SelectValue placeholder="Grant a department access" />
                  </SelectTrigger>
                  <SelectContent>
                    {departments.map((dept) => (
                      <SelectItem key={dept.id} value={dept.id}>
                        {dept.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={grantChoice[group.id]?.kind === 'team' ? grantChoice[group.id]!.id : ''}
                  onValueChange={(value) =>
                    setGrantChoice((prev) => ({ ...prev, [group.id]: { kind: 'team', id: value } }))
                  }
                >
                  <SelectTrigger className="h-8 w-[220px]">
                    <SelectValue placeholder="Grant a team access" />
                  </SelectTrigger>
                  <SelectContent>
                    {teams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  disabled={!grantChoice[group.id]}
                  onClick={() => handleGrant(group.id)}
                >
                  Grant
                </Button>
              </div>
            </div>
          ))}
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No groups yet — create one above.</p>
          ) : null}
        </div>
      )}
    </div>
  )
}
