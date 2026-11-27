import type { ReactNode } from 'react'
import type { AutomationRowMark } from '../../../../../src/shared/automations/automation-chat-row'
import { botWaitTimeFormat } from '../../../../../src/shared/bots/bot-row-line'
import {
  MobileNativeChatEventName,
  MobileNativeChatEventRow
} from './messages/MobileNativeChatEventRow'
import { MobileAutomationMark } from './MobileAutomationMark'

/** "2:10 PM", as automation wording reads a time on the phone. */
export function mobileAutomationRowTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** A time automation wording names ("Runs once at Tue 12:05 AM"): with its day when not today, as
 *  on the desktop, so a short timer across midnight doesn't read as today. */
export function mobileAutomationWordingTime(at: number, now = Date.now()): string {
  return new Intl.DateTimeFormat(undefined, botWaitTimeFormat(at, now)).format(at)
}

/** Every automation row in a phone chat, as a status row: its trigger's mark, "<lead> · <name> · <status>"
 *  (or "<lead> <name>" for a verb such as Couldn't start), then its details when opened. With a
 *  subtitle the words are the name alone, the subtitle says what happened. */
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
  subtitle,
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
  /** The line under the name, such as "Couldn't start · 2:14 AM"; the row then shows no time. */
  subtitle?: { node: ReactNode; label: string }
  fontScale: number
  testID?: string
  children?: ReactNode
}): React.JSX.Element {
  const after = status ? [status] : []
  const label = subtitle
    ? `${name}, ${subtitle.label}`
    : leadIsVerb
      ? [`${lead} ${name}`, ...after].join(' · ')
      : [lead, name, ...after].join(' · ')
  return (
    <MobileNativeChatEventRow
      testID={testID}
      icon={<MobileAutomationMark mark={mark} />}
      badge={failed ? 'failed' : null}
      label={label}
      action={action}
      timestamp={subtitle ? null : timestamp}
      disclosureKey={disclosureKey}
      fontScale={fontScale}
      details={children}
      subtitle={subtitle?.node}
      wordsLines={subtitle ? 2 : 1}
    >
      {subtitle ? null : (
        <>
          {lead}
          {leadIsVerb ? ' ' : ' · '}
        </>
      )}
      <MobileNativeChatEventName>{name}</MobileNativeChatEventName>
      {status ? ` · ${status}` : null}
    </MobileNativeChatEventRow>
  )
}
