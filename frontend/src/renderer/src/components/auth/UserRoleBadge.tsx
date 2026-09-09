// TASK-FE-010: UserRoleBadge — small chip displaying the user's role.
// Kept intentionally simple: pure, no hooks, no side effects.
import type { OrcaUserRole } from '../../store/slices/auth'

type Props = { role: OrcaUserRole }

const ROLE_LABELS: Record<OrcaUserRole, string> = {
  developer: 'developer',
  admin: 'admin'
}

export function UserRoleBadge({ role }: Props) {
  return <span className={`role-badge role-badge--${role}`}>{ROLE_LABELS[role]}</span>
}
