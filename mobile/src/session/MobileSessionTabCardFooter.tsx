import { Text } from 'react-native'
import { File, FileText, Globe, SquareTerminal } from 'lucide-react-native'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { AgentStateDot } from '../components/AgentStateDot'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import type { mobileSessionTabCardContent } from './mobile-session-tab-card-content'

export function MobileSessionTabCardFooter({
  content
}: {
  content: ReturnType<typeof mobileSessionTabCardContent>
}) {
  useMobileColorScheme()
  const Icon =
    content.kind === 'browser'
      ? Globe
      : content.kind === 'markdown'
        ? FileText
        : content.kind === 'file'
          ? File
          : SquareTerminal
  return (
    <>
      {content.state ? <AgentStateDot state={content.state} /> : null}
      {content.agentId ? (
        <MobileAgentIcon agentId={content.agentId} size={16} />
      ) : (
        <Icon size={16} color={colors.textSecondary} />
      )}
      <Text style={styles.sessionMetaText}>{content.programName}</Text>
    </>
  )
}
