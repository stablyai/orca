import { Image, StyleSheet, Text, View } from 'react-native'
import { Terminal } from 'lucide-react-native'
import Svg, { Defs, G, LinearGradient, Path, Stop } from 'react-native-svg'
import { colors } from '../theme/mobile-theme'
import { MOBILE_AGENT_CATALOG } from '../tasks/mobile-agent-catalog'
import { ClaudeIcon, OpenAIIcon } from './AgentIcons'

// Why: agent branding should match the desktop/new-worktree picker everywhere
// mobile lets users choose the agent that will own a workspace.

function PiIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 800 800">
      <Path
        fill={colors.textPrimary}
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <Path fill={colors.textPrimary} d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </Svg>
  )
}

function OmpIcon({ size = 16 }: { size?: number }) {
  // SVG sourced from omp.sh's transparent homepage mark. Why: react-native-svg
  // does not support the homepage's CSS oklch stops, so use its favicon hex stops.
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="ompMarkGradient" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#ed4abf" />
          <Stop offset=".5" stopColor="#9b4dff" />
          <Stop offset="1" stopColor="#5ad8e6" />
        </LinearGradient>
      </Defs>
      <Path fill="url(#ompMarkGradient)" d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z" />
    </Svg>
  )
}

function AiderIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 436 436">
      <G transform="translate(0,436) scale(0.1,-0.1)" fill={colors.textPrimary} stroke="none">
        <Path d="M0 2180 l0 -2180 2180 0 2180 0 0 2180 0 2180 -2180 0 -2180 0 0 -2180z m2705 1818 c20 -20 28 -121 30 -398 l2 -305 216 -5 c118 -3 218 -8 222 -12 3 -3 10 -46 15 -95 5 -48 16 -126 25 -172 17 -86 17 -81 -17 -233 -14 -67 -13 -365 2 -438 21 -100 22 -159 5 -247 -24 -122 -24 -363 1 -458 23 -88 23 -213 1 -330 -9 -49 -17 -109 -17 -132 l0 -43 203 0 c111 0 208 -4 216 -9 10 -6 18 -51 27 -148 8 -76 16 -152 20 -168 7 -39 -23 -361 -37 -387 -10 -18 -21 -19 -214 -16 -135 2 -208 7 -215 14 -22 22 -33 301 -21 501 6 102 8 189 5 194 -8 13 -417 12 -431 -2 -12 -12 -8 -146 8 -261 8 -55 8 -95 1 -140 -6 -35 -14 -99 -17 -143 -9 -123 -14 -141 -41 -154 -18 -8 -217 -11 -679 -11 l-653 0 -11 33 c-31 97 -43 336 -27 533 5 56 6 113 2 128 l-6 26 -194 0 c-211 0 -252 4 -261 28 -12 33 -17 392 -6 522 15 186 -2 174 260 180 115 3 213 8 217 12 4 4 1 52 -5 105 -7 54 -17 130 -22 168 -7 56 -5 91 11 171 10 55 22 130 26 166 4 36 10 72 15 79 7 12 128 15 665 19 l658 5 8 30 c5 18 4 72 -3 130 -12 115 -7 346 11 454 10 61 10 75 -1 82 -8 5 -300 9 -650 9 l-636 0 -27 25 c-18 16 -26 34 -26 57 0 18 -5 87 -10 153 -10 128 5 449 22 472 5 7 26 13 46 15 78 6 1281 3 1287 -4z" />
        <Path d="M1360 1833 c0 -5 -1 -164 -3 -356 l-2 -347 625 -1 c704 -1 708 -1 722 7 5 4 7 20 4 38 -29 141 -32 491 -6 595 9 38 8 45 -7 57 -15 11 -139 13 -675 14 -362 0 -658 -3 -658 -7z" />
      </G>
    </Svg>
  )
}

function FaviconIcon({ domain, size = 16 }: { domain: string; size?: number }) {
  return (
    <Image
      source={{ uri: `https://www.google.com/s2/favicons?domain=${domain}&sz=64` }}
      style={{ width: size, height: size, borderRadius: 2 }}
    />
  )
}

function AgentLetterIcon({ letter, size = 16 }: { letter: string; size?: number }) {
  return (
    <View
      style={[
        styles.letterIcon,
        {
          width: size,
          height: size,
          borderRadius: size * 0.22,
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
  if (agentId === 'claude') {
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
