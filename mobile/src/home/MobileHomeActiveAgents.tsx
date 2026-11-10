import { memo } from 'react'
import type { AgentListRow } from '../agents/agent-list-rows'
import { MobileAgentListRows, type AgentListRowHandlers } from '../agents/MobileAgentListRows'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { HostProfile } from '../transport/hosts/host-profile'
import { areStructurallyEqual } from '../worktree/structural-equality'
import { MobileHomeSectionHeading } from './MobileHomeSectionHeading'

// Enough to act on without pushing Desktops off the first screen; the Agents tab has the rest.
const ACTIVE_ROWS_SHOWN = 3

/** Feed's short list of agents waiting on the user or working, those waiting first; hidden when none are. */
export const MobileHomeActiveAgents = memo(function MobileHomeActiveAgents(props: {
  handlers: AgentListRowHandlers
  rows: readonly AgentListRow[]
  hosts: readonly HostProfile[]
  now: number
  onSeeAll: () => void
}) {
  const t = useMobileTranslation()
  if (props.rows.length === 0) {
    return null
  }
  return (
    <>
      <MobileHomeSectionHeading
        title={t('home.activeAgents.heading', 'Active')}
        count={props.rows.length}
        aside={t('home.activeAgents.seeAll', 'See all agents')}
        onAsidePress={props.onSeeAll}
        first
      />
      <MobileAgentListRows
        rows={props.rows.slice(0, ACTIVE_ROWS_SHOWN)}
        footer="workspace"
        nameDesktop={props.hosts.length > 1}
        hosts={props.hosts}
        now={props.now}
        handlers={props.handlers}
      />
    </>
  )
}, areStructurallyEqual)
