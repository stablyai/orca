// AuditTab — Admin Console's Audit Log tab (FE-TASK-019, CR-RBAC-001).
// from/date filter + actor/outcome filters (FE-TASK-016, CR-RBAC-005) + a
// results table.
import { useEffect, useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { toast } from 'sonner'
import type { AdminAuditEntry, AdminAuditOutcome } from '../../../../shared/admin-audit-types'

function formatTimestamp(unixMs: number): string {
  return new Date(unixMs).toLocaleString()
}

export function AuditTab(): React.JSX.Element {
  const [entries, setEntries] = useState<AdminAuditEntry[]>([])
  const [loading, setLoading] = useState(false)
  // `from` is a <input type="date"> value (yyyy-mm-dd); converted to
  // sinceUnixMs below. There is no `to` filter on the backend today — only
  // `since` (channels_admin_audit.go's queryArgs) — so a `to` input would be
  // client-side-only filtering; left out of this base skeleton per
  // FE-TASK-019's scope (actor/outcome filters, not date-range refinement,
  // are the next increment).
  const [from, setFrom] = useState('')
  // actorId filters by raw actor/user id (no directory lookup yet — basic
  // scaffold per FE-TASK-016); outcome '' means unfiltered.
  const [actorId, setActorId] = useState('')
  const [outcome, setOutcome] = useState<AdminAuditOutcome | ''>('')

  useEffect(() => {
    setLoading(true)
    const sinceUnixMs = from ? new Date(from).getTime() : undefined
    window.api.admin
      .queryAuditLog({
        sinceUnixMs,
        actorId: actorId.trim() || undefined,
        outcome: outcome || undefined
      })
      .then((result) => setEntries(result.entries))
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [from, actorId, outcome])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="audit-from">
            From
          </label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8 w-40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="audit-actor">
            Actor
          </label>
          <Input
            id="audit-actor"
            type="text"
            placeholder="Actor ID"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            className="h-8 w-40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="audit-outcome">
            Outcome
          </label>
          <Select
            value={outcome || 'all'}
            onValueChange={(v) => setOutcome(v === 'all' ? '' : (v as AdminAuditOutcome))}
          >
            <SelectTrigger id="audit-outcome" className="h-8 w-[140px]">
              <SelectValue placeholder="All outcomes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All outcomes</SelectItem>
              <SelectItem value="allowed">Allowed</SelectItem>
              <SelectItem value="denied">Denied</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {loading && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="text-xs">{formatTimestamp(entry.occurredAtUnixMs)}</TableCell>
                <TableCell className="text-xs">{entry.actorId}</TableCell>
                <TableCell className="text-xs">{entry.action}</TableCell>
                <TableCell className="text-xs">{entry.target}</TableCell>
                <TableCell className="text-xs">
                  <Badge variant={entry.outcome === 'denied' ? 'destructive' : 'default'}>
                    {entry.outcome}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                  No audit entries found.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
