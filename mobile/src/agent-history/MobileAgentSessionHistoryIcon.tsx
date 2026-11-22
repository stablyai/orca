import type { LucideProps } from 'lucide-react-native'
import Svg, { Path } from 'react-native-svg'
import type { AppIcon } from '../components/icons/app-icon-types'
import { asAppIcon } from '../components/icons/as-app-icon'

// Lucide's prop types, so menus can render it as one of their icons.
type MobileAgentSessionHistoryIconProps = Pick<LucideProps, 'size' | 'color' | 'strokeWidth'>

export function MobileAgentSessionHistoryIcon({
  size = 18,
  color = '#000000',
  strokeWidth = 2
}: MobileAgentSessionHistoryIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Why: desktop uses Tabler's category glyph for Agent Session History. */}
      <Path stroke="none" d="M0 0h24v24H0z" fill="none" />
      <Path
        d="M14 4h6v6h-6z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M4 14h6v6h-6z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M17 17m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M7 7m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** The glyph as a menu icon; phones show the matching platform symbol. */
export const AgentSessionHistoryMenuIcon: AppIcon = Object.assign(
  asAppIcon(MobileAgentSessionHistoryIcon, { ios: 'square.on.circle', android: 'category' }),
  // The name a web-shell page sends; the shell finds these symbols under it.
  { displayName: 'AgentSessionHistory' }
)
