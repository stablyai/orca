// TeamsTab — Admin Console's Teams tab (FE-TASK-020, CR-RBAC-001). Mirrors
// admin-org-console-users-tab.tsx / admin-org-console-policies-tab.tsx's
// list+create+per-row-actions structure, bridged through window.api.admin.*
// (team.* wire channels — see admin-team-types.ts's doc comment for why
// AdminTeam/AdminTeamMember are snake_case unlike every other admin.* type).
//
// AdminTeamMember has NO `role` field (tenant.proto's TeamMember only
// declares user_id/priority) — do not add one here.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import type { AdminTeam, AdminTeamMember } from '../../../../shared/admin-team-types'

function CreateTeamForm(props: { onCreated: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [settingsJson, setSettingsJson] = useState('')
  const [creating, setCreating] = useState(false)

  const canSubmit = name.trim().length > 0

  const handleCreate = useCallback(() => {
    if (!canSubmit || creating) {
      return
    }
    setCreating(true)
    window.api.admin
      .createTeam({ name: name.trim(), settingsJson: settingsJson.trim() || undefined })
      .then(() => {
        setName('')
        setSettingsJson('')
        toast.success('Team created')
        props.onCreated()
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreating(false))
  }, [canSubmit, creating, name, settingsJson, props])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Team name"
          className="w-56"
        />
        <Button disabled={!canSubmit || creating} onClick={handleCreate}>
          {creating ? 'Creating…' : 'Create team'}
        </Button>
      </div>
      <Textarea
        value={settingsJson}
        onChange={(e) => setSettingsJson(e.target.value)}
        placeholder="Settings JSON (optional)"
        className="h-16 font-mono text-xs"
      />
    </div>
  )
}

function AddTeamMemberForm(props: { teamId: string; onAdded: () => void }): React.JSX.Element {
  const [userId, setUserId] = useState('')
  const [priority, setPriority] = useState('')
  const [adding, setAdding] = useState(false)

  const canSubmit = userId.trim().length > 0

  const handleAdd = useCallback(() => {
    if (!canSubmit || adding) {
      return
    }
    const trimmedPriority = priority.trim()
    const parsedPriority = trimmedPriority.length > 0 ? Number(trimmedPriority) : undefined
    if (parsedPriority !== undefined && Number.isNaN(parsedPriority)) {
      toast.error('Priority must be a number')
      return
    }
    setAdding(true)
    window.api.admin
      .addTeamMember({ teamId: props.teamId, userId: userId.trim(), priority: parsedPriority })
      .then(() => {
        setUserId('')
        setPriority('')
        toast.success('Member added')
        props.onAdded()
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setAdding(false))
  }, [canSubmit, adding, priority, props, userId])

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Input
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        placeholder="User ID"
        className="w-56"
      />
      <Input
        value={priority}
        onChange={(e) => setPriority(e.target.value)}
        placeholder="Priority (optional)"
        className="w-40"
      />
      <Button size="sm" disabled={!canSubmit || adding} onClick={handleAdd}>
        {adding ? 'Adding…' : 'Add member'}
      </Button>
    </div>
  )
}

function TeamMembersPanel(props: { teamId: string }): React.JSX.Element {
  const [members, setMembers] = useState<AdminTeamMember[]>([])
  const [loading, setLoading] = useState(false)
  const [busyUserId, setBusyUserId] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    setLoading(true)
    window.api.admin
      .listTeamMembers({ teamId: props.teamId })
      .then(setMembers)
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [props.teamId, reloadToken])

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  const handleRemove = useCallback(
    (userId: string) => {
      setBusyUserId(userId)
      window.api.admin
        .removeTeamMember({ teamId: props.teamId, userId })
        .then(() => {
          toast.success('Member removed')
          reload()
        })
        .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusyUserId(null))
    },
    [props.teamId, reload]
  )

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3">
      <AddTeamMemberForm teamId={props.teamId} onAdded={reload} />
      {loading && members.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading members…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {members.map((member) => (
            <div
              key={member.user_id}
              className="flex items-center justify-between gap-2 rounded border border-border bg-background px-3 py-2"
            >
              <div>
                <p className="text-sm">{member.user_id}</p>
                <p className="text-xs text-muted-foreground">priority: {member.priority}</p>
              </div>
              <Button
                size="sm"
                variant="destructive"
                disabled={busyUserId === member.user_id}
                onClick={() => handleRemove(member.user_id)}
              >
                Remove
              </Button>
            </div>
          ))}
          {members.length === 0 ? (
            <p className="text-xs text-muted-foreground">No members yet.</p>
          ) : null}
        </div>
      )}
    </div>
  )
}

function TeamRow(props: {
  team: AdminTeam
  expanded: boolean
  onToggleExpanded: () => void
}): React.JSX.Element {
  const { team } = props
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{team.name}</p>
          <p className="text-xs text-muted-foreground">company: {team.company_id}</p>
        </div>
        <Button size="sm" variant="outline" onClick={props.onToggleExpanded}>
          {props.expanded ? 'Hide members' : 'Manage members'}
        </Button>
      </div>
      {props.expanded ? <TeamMembersPanel teamId={team.id} /> : null}
    </div>
  )
}

export function TeamsTab(): React.JSX.Element {
  const [teams, setTeams] = useState<AdminTeam[]>([])
  const [loading, setLoading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    window.api.admin
      .listTeams()
      .then(setTeams)
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [reloadToken])

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  if (loading && teams.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  return (
    <div className="flex flex-col gap-4">
      <CreateTeamForm onCreated={reload} />
      <div className="flex flex-col gap-3">
        {teams.map((team) => (
          <TeamRow
            key={team.id}
            team={team}
            expanded={expandedTeamId === team.id}
            onToggleExpanded={() =>
              setExpandedTeamId((prev) => (prev === team.id ? null : team.id))
            }
          />
        ))}
        {teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">No teams found.</p>
        ) : null}
      </div>
    </div>
  )
}
