// PoliciesTab — Admin Console's Policies tab (FE-TASK-018, CR-RBAC-001).
// Mirrors admin-org-console-users-tab.tsx's list+create+per-row-actions
// structure. AccessPolicy is a versioned JSON document (not a multi-field
// form like the old Hệ B AdminPolicy), so the minimal UI is a name/kind
// input pair + a raw JSON textarea for the document.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import type { AdminAccessPolicy } from '../../../../shared/admin-policy-types'

// CR-RBAC-006 (OPA bundle publish pipeline) has not landed yet — saving a
// policy here persists it but has no real enforcement effect until that
// lands (channels_admin_policies.go's own doc comment). Surfacing this
// banner is required by this tab's task spec until CR-RBAC-006 ships.
function PolicyPublishWarningBanner(): React.JSX.Element {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
      Changes may not take effect yet — policy enforcement publish is not wired live (CR-RBAC-006).
    </div>
  )
}

function CreatePolicyForm(props: { onCreated: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [kind, setKind] = useState('')
  const [documentJson, setDocumentJson] = useState('{}')
  const [creating, setCreating] = useState(false)

  const canSubmit = name.trim().length > 0 && kind.trim().length > 0

  const handleCreate = useCallback(() => {
    if (!canSubmit || creating) {
      return
    }
    setCreating(true)
    window.api.admin
      .createPolicy({ name: name.trim(), kind: kind.trim(), documentJson })
      .then(() => {
        setName('')
        setKind('')
        setDocumentJson('{}')
        toast.success('Policy created')
        props.onCreated()
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreating(false))
  }, [canSubmit, creating, name, kind, documentJson, props])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Policy name"
          className="w-56"
        />
        <Input
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          placeholder="Kind"
          className="w-40"
        />
        <Button disabled={!canSubmit || creating} onClick={handleCreate}>
          {creating ? 'Creating…' : 'Create policy'}
        </Button>
      </div>
      <Textarea
        value={documentJson}
        onChange={(e) => setDocumentJson(e.target.value)}
        placeholder="{}"
        className="h-24 font-mono text-xs"
      />
    </div>
  )
}

function PolicyRow(props: { policy: AdminAccessPolicy; onChanged: () => void }): React.JSX.Element {
  const { policy } = props
  const [editing, setEditing] = useState(false)
  const [documentJson, setDocumentJson] = useState(policy.documentJson)
  const [busy, setBusy] = useState(false)

  const handleSave = useCallback(() => {
    setBusy(true)
    window.api.admin
      .updatePolicy({ policyId: policy.id, documentJson, expectedVersion: policy.version })
      .then(() => {
        toast.success('Policy updated')
        setEditing(false)
        props.onChanged()
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }, [policy.id, policy.version, documentJson, props])

  const handleDelete = useCallback(() => {
    setBusy(true)
    window.api.admin
      .deletePolicy({ policyId: policy.id })
      .then(() => {
        toast.success('Policy deleted')
        props.onChanged()
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }, [policy.id, props])

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{policy.name}</p>
          <p className="text-xs text-muted-foreground">
            {policy.kind} · v{policy.version} · updated by {policy.updatedBy || 'unknown'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setEditing((prev) => !prev)}
          >
            {editing ? 'Cancel' : 'Edit'}
          </Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={handleDelete}>
            Delete
          </Button>
        </div>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={documentJson}
            onChange={(e) => setDocumentJson(e.target.value)}
            className="h-32 font-mono text-xs"
          />
          <Button size="sm" disabled={busy} onClick={handleSave} className="self-start">
            Save
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function PoliciesTab(): React.JSX.Element {
  const [policies, setPolicies] = useState<AdminAccessPolicy[]>([])
  const [loading, setLoading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    setLoading(true)
    window.api.admin
      .listPolicies()
      .then((result) => setPolicies(result.policies))
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [reloadToken])

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  if (loading && policies.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  return (
    <div className="flex flex-col gap-4">
      <PolicyPublishWarningBanner />
      <CreatePolicyForm onCreated={reload} />
      <div className="flex flex-col gap-3">
        {policies.map((policy) => (
          <PolicyRow key={policy.id} policy={policy} onChanged={reload} />
        ))}
        {policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No policies found.</p>
        ) : null}
      </div>
    </div>
  )
}
