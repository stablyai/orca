// A create's tab, for the person its creator named before the chat existed.
import type { NewChatTabPerson, TabPerson } from '../../../../../bots/team-share/teammate-rules'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { PreparedStructuredAgentSessionCreate } from './structured-agent-session-create'

type PersonTab = NonNullable<PreparedStructuredAgentSessionCreate['tab']> & { person: TabPerson }

/** No one's create has no tab. A teammate's own list, or no one's, founds the chat with no host tab
 *  row, so no restore of the owner's tabs can ever show it. */
export function withCreateTabPerson(
  runtime: Pick<OrcaRuntimeService, 'teammateChatList'>,
  prepared: PreparedStructuredAgentSessionCreate,
  person: NewChatTabPerson
): Omit<PreparedStructuredAgentSessionCreate, 'tab'> & { tab: PersonTab | null } {
  const tab = person === 'no-one' || !prepared.tab ? null : { ...prepared.tab, person }
  const hidden =
    person === 'no-one' || (tab !== null && runtime.teammateChatList(tab.person, tab.workspaceId))
  return hidden
    ? { ...prepared, tab, attachParams: { ...prepared.attachParams, hostTab: false } }
    : { ...prepared, tab }
}
