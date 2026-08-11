import Svg, { Path } from 'react-native-svg'

type MobileAgentSessionHistoryIconProps = {
  size?: number
  color?: string
  strokeWidth?: number
}

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
