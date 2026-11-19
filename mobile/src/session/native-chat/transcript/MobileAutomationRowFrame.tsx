import type { ReactNode } from 'react'
import type { AutomationRowMark } from '../../../../../src/shared/automations/automation-chat-row'
import {
  MobileNativeChatEventName,
  MobileNativeChatEventRow
} from './messages/MobileNativeChatEventRow'
import { MobileAutomationMark } from './MobileAutomationMark'

/** "2:10 PM", as automation wording reads a time on the phone. */
export function mobileAutomationRowTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Every automation row in a phone chat, as a status row: its trigger's mark, "<lead> · <name> · <status>"
 *  (or "<lead> <name>" for a verb such as Couldn't start), then its details when opened. */
export function MobileAutomationRowFrame({
  mark,
  lead,
  name,
  status,
  leadIsVerb = false,
  failed = false,
  timestamp,
  disclosureKey,
  action,
  fontScale,
  testID,
  children
}: {
  mark: AutomationRowMark
  lead: string
  name: string
  status?: string | null
  leadIsVerb?: boolean
  /** A red ✕ on the mark: it couldn't start or finish. */
  failed?: boolean
  timestamp: number | null
  disclosureKey: string
  action?: ReactNode
  fontScale: number
  testID?: string
  children?: ReactNode
}): React.JSX.Element {
  const after = status ? [status] : []
  const label = leadIsVerb
    ? [`${lead} ${name}`, ...after].join(' · ')
    : [lead, name, ...after].join(' · ')
  return (
    <MobileNativeChatEventRow
      testID={testID}
      icon={<MobileAutomationMark mark={mark} />}
      badge={failed ? 'failed' : null}
      label={label}
      action={action}
      timestamp={timestamp}
      disclosureKey={disclosureKey}
      fontScale={fontScale}
      details={children}
    >
      {lead}
      {leadIsVerb ? ' ' : ' · '}
      <MobileNativeChatEventName>{name}</MobileNativeChatEventName>
      {status ? ` · ${status}` : null}
    </MobileNativeChatEventRow>
  )
}
