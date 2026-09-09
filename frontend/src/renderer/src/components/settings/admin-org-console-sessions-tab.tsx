// UserSessionsPanel — Admin Console's per-user Sessions panel (FE-TASK-021,
// CR-RBAC-001).
//
// CR-RBAC-001: backend-go only has ListSessionsForUser (scoped to one
// userId) — no cross-user "list all sessions" RPC exists
// (channels_admin_sessions.go's admin.listSessions bridges exactly that
// single-user RPC). This is a deliberate difference from Hệ B's
// SessionsPage.tsx (a flat all-users table): this panel opens from one row
// in the Users tab (see admin-org-console-users-tab.tsx's "View sessions"
// button) rather than being a standalone tab/route.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from 'sonner'
import type { AdminSession } from '../../../../shared/admin-session-types'

function formatTimestamp(unixMs: number): string {
  return new Date(unixMs).toLocaleString()
}

export function UserSessionsPanel(props: {
  userId: string
  userLabel: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { userId, userLabel, open, onOpenChange } = props
  const [sessions, setSessions] = useState<AdminSession[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!open) {
      return
    }
    setLoading(true)
    window.api.admin
      .listSessions({ userId })
      .then((result) => setSessions(result.sessions))
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [open, userId, reloadToken])

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  const handleRevokeOne = useCallback(
    (sessionId: string) => {
      setBusyId(sessionId)
      window.api.admin
        .forceRevokeSession({ sessionId })
        .then(() => {
          toast.success('Session revoked')
          reload()
        })
        .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusyId(null))
    },
    [reload]
  )

  const handleRevokeAll = useCallback(() => {
    setBusyId('*')
    window.api.admin
      .forceRevokeAllSessions({ userId })
      .then((result) => {
        toast.success(`Revoked ${result.revokedCount} session(s)`)
        reload()
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusyId(null))
  }, [userId, reload])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sessions — {userLabel}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="destructive"
              disabled={busyId !== null || sessions.length === 0}
              onClick={handleRevokeAll}
            >
              Revoke all sessions
            </Button>
          </div>
          {loading && sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-col gap-2">
              {sessions.map((session) => (
                <div
                  key={session.sessionId}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border p-3"
                >
                  <div className="text-xs text-muted-foreground">
                    <p>
                      {session.ip || 'unknown IP'} · {session.userAgent || 'unknown agent'}
                    </p>
                    <p>
                      Created {formatTimestamp(session.createdAtUnixMs)} · Last seen{' '}
                      {formatTimestamp(session.lastSeenAtUnixMs)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId !== null}
                    onClick={() => handleRevokeOne(session.sessionId)}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
              {sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active sessions.</p>
              ) : null}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
