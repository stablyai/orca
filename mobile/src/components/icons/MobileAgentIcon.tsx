import providerMarks from '../../../../src/shared/agent-icons/provider-marks.json'
import { useId } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import type { ImageSourcePropType } from 'react-native'
import { Terminal } from 'lucide-react-native'
import Svg, { Defs, G, LinearGradient, Path, Stop } from 'react-native-svg'
import { colors, radii } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MOBILE_AGENT_CATALOG } from '../../agents/mobile-agent-catalog'
import { MOBILE_AGENT_ICON_ASSETS } from './mobile-agent-icon-assets'
import { ClaudeIcon, OpenAIIcon } from './AgentIcons'

const iconAssets: Partial<Record<string, ImageSourcePropType>> = MOBILE_AGENT_ICON_ASSETS

// Match desktop/new-worktree agent branding across mobile pickers.

function PiIcon({ size = 16 }: { size?: number }) {
  useMobileColorScheme()
  return (
    <Svg width={size} height={size} viewBox="0 0 800 800">
      <Path fill={colors.textPrimary} fillRule="evenodd" d={providerMarks.pi.path} />
      <Path fill={colors.textPrimary} d={providerMarks.pi.secondaryPath} />
    </Svg>
  )
}

function OmpIcon({ size = 16 }: { size?: number }) {
  // Use omp.sh transparent mark with favicon hex stops because RN SVG cannot parse homepage CSS oklch stops.
  const gradientId = `ompMarkGradient-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={providerMarks.omp.gradient[0]} />
          <Stop offset="0.5" stopColor={providerMarks.omp.gradient[1]} />
          <Stop offset="1" stopColor={providerMarks.omp.gradient[2]} />
        </LinearGradient>
      </Defs>
      <Path fill={`url(#${gradientId})`} d={providerMarks.omp.path} />
    </Svg>
  )
}

function AiderIcon({ size = 16 }: { size?: number }) {
  useMobileColorScheme()
  return (
    <Svg width={size} height={size} viewBox="0 0 436 436">
      <G transform="translate(0,436) scale(0.1,-0.1)" fill={colors.textPrimary} stroke="none">
        <Path d={providerMarks.aider.path} />
        <Path d={providerMarks.aider.secondaryPath} />
      </G>
    </Svg>
  )
}

function BundledIcon({ source, size = 16 }: { source: ImageSourcePropType; size?: number }) {
  return (
    <Image
      source={source}
      defaultSource={Array.isArray(source) ? undefined : source}
      style={{ width: size, height: size, borderRadius: radii.mark }}
    />
  )
}

function FaviconIcon({ domain, size = 16 }: { domain: string; size?: number }) {
  return (
    <Image
      source={{ uri: `https://www.google.com/s2/favicons?domain=${domain}&sz=64` }}
      style={{ width: size, height: size, borderRadius: radii.mark }}
    />
  )
}

function AgentLetterIcon({ letter, size = 16 }: { letter: string; size?: number }) {
  useMobileColorScheme()
  return (
    <View
      style={[
        styles.letterIcon,
        {
          width: size,
          height: size,
          borderRadius: radii.mark,
          backgroundColor: colors.textMuted + '33'
        }
      ]}
    >
      <Text style={[styles.letterIconText, { fontSize: size * 0.55, color: colors.textPrimary }]}>
        {letter}
      </Text>
    </View>
  )
}

export function MobileAgentIcon({ agentId, size = 16 }: { agentId: string; size?: number }) {
  useMobileColorScheme()
  if (agentId === 'claude' || agentId === 'claude-agent-teams') {
    return <ClaudeIcon size={size} />
  }
  if (agentId === 'codex') {
    return <OpenAIIcon size={size} />
  }
  if (agentId === 'pi') {
    return <PiIcon size={size} />
  }
  if (agentId === 'omp') {
    return <OmpIcon size={size} />
  }
  if (agentId === 'aider') {
    return <AiderIcon size={size} />
  }
  if (agentId === '__blank__' || agentId === 'blank') {
    return <Terminal size={size} color={colors.textMuted} />
  }

  // Use bundled favicon instead of Google service for offline/regional availability (#8451).
  const iconAgentId = agentId === 'dsb' ? 'dsh' : agentId
  const bundledIcon = iconAssets[iconAgentId]
  if (bundledIcon) {
    return <BundledIcon source={bundledIcon} size={size} />
  }
  const agent = MOBILE_AGENT_CATALOG.find((entry) => entry.id === agentId)
  if (agent?.faviconDomain) {
    return <FaviconIcon domain={agent.faviconDomain} size={size} />
  }
  const label = agent?.label ?? agentId
  return <AgentLetterIcon letter={label.charAt(0).toUpperCase()} size={size} />
}

const styles = StyleSheet.create({
  letterIcon: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  letterIconText: {
    fontWeight: '700'
  }
})
