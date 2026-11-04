import type { ComponentProps, ReactNode } from 'react'
import { Text } from 'react-native'
import type { MailReportPresentation } from '../../../../../src/shared/agent-session/mail-report-presentation'
import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { styles } from './mobile-native-chat-message-styles'
import {
  MobileNativeChatAgentMessageCard,
  MobileNativeChatAgentMessageSenders
} from './MobileNativeChatAgentMessageCard'

export function MobileNativeChatMailMessage({
  report,
  from,
  children,
  ...props
}: Omit<ComponentProps<typeof MobileNativeChatAgentMessageCard>, 'from'> & {
  from?: AgentMessageSource
  report?: MailReportPresentation
  children?: ReactNode
}) {
  const t = useMobileTranslation()
  if (!report) {
    return from ? <MobileNativeChatAgentMessageCard {...props} from={from} /> : null
  }
  const result = report.report?.result
  return (
    <>
      {from ? (
        <MobileNativeChatAgentMessageSenders from={from} />
      ) : (
        <Text style={styles.agentAttribution}>{report.source}</Text>
      )}
      {result ? (
        <Text style={styles.agentAttribution}>
          {result.type === 'exit'
            ? t('session.backgroundTask.commandExit', 'Exit {{code}}', { code: result.code })
            : t('session.backgroundTask.commandSignal', 'Signal {{signal}}', {
                signal: result.signal
              })}
        </Text>
      ) : null}
      {props.attachments}
      {children}
      {props.status}
    </>
  )
}
