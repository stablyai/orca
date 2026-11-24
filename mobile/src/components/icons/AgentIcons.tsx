import providerMarks from '../../../../src/shared/agent-icons/provider-marks.json'
import Svg, { Path } from 'react-native-svg'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

// Use desktop status-bar SVG paths to keep Claude/Codex branding identical.

export function ClaudeIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={providerMarks.claude.path} fill="#D97757" fillRule="nonzero" />
    </Svg>
  )
}

export function OpenAIIcon({ size = 16, color }: { size?: number; color?: string }) {
  useMobileColorScheme()
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={providerMarks.codex.path} fill={color ?? colors.textPrimary} fillRule="evenodd" />
    </Svg>
  )
}
