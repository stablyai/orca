import { View } from 'react-native'
import {
  BOT_WORKSPACE_LINE_LOGO,
  type BotWorkspaceLineAgent
} from '../../../../src/shared/bots/bot-sidebar-workspaces'
import { formatAgentTypeLabel } from '../../../../src/shared/agent-status/presentation/agent-type-label'
import { colors } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileAgentIcon } from '../../components/icons/MobileAgentIcon'

/** A bot worker line's agents by logo, one per kind, overlapping as on the desktop. */
export function BotLineAgentLogos({
  agent,
  ringColor = colors.bgBase
}: {
  agent: BotWorkspaceLineAgent
  /** The row's surface, which the gap between logos shows, as MobileBotFaceStack does. */
  ringColor?: string
}) {
  useMobileColorScheme()
  const { size, step, gap } = BOT_WORKSPACE_LINE_LOGO
  return (
    <View
      style={{ width: (agent.agentTypes.length - 1) * step + size, height: size }}
      accessibilityLabel={agent.agentTypes.map((type) => formatAgentTypeLabel(type)).join(', ')}
    >
      {agent.agentTypes.map((type, index) => {
        // Later logos sit on earlier ones; a ring in the row's colour keeps them apart.
        const ring = index > 0 ? gap : 0
        return (
          <View
            key={type}
            style={[
              styles.logo,
              {
                left: index * step - ring,
                top: -ring,
                borderWidth: ring,
                borderColor: ringColor,
                backgroundColor: index > 0 ? ringColor : undefined,
                borderRadius: size / 2 + ring
              }
            ]}
          >
            <MobileAgentIcon agentId={type} size={size} />
          </View>
        )
      })}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  logo: { position: 'absolute' }
}))
