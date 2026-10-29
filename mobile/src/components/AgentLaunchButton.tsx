import { useLocalSearchParams } from 'expo-router'
import { MessageSquare, Terminal } from 'lucide-react-native'
import { Pressable, StyleSheet, Text } from 'react-native'
import type { AgentLaunchResult } from '../../../src/shared/agent-launch-intent'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import { firstParam } from '../navigation/route-param-reader'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function AgentLaunchButton({ launch }: { launch: AgentLaunchResult }) {
  useMobileColorScheme()
  const params = useLocalSearchParams<{ hostId?: string | string[]; name?: string | string[] }>()
  const router = useWorkspaceRouteHandoff()
  const { outcome } = launch
  const isChat = outcome.kind === 'structured'
  const paneKey =
    outcome.kind === 'structured'
      ? structuredAgentSessionPaneKey(
          outcome.tabId ?? structuredAgentSessionTabId(outcome.sessionId),
          outcome.sessionId
        )
      : outcome.paneKey
  const label = isChat ? 'Open chat' : paneKey ? 'Open terminal' : 'Open workspace'
  const Icon = isChat ? MessageSquare : Terminal

  const open = () => {
    const query = new URLSearchParams()
    const name = firstParam(params.name)
    if (name) {
      query.set('name', name)
    }
    if (paneKey) {
      query.set('paneKey', paneKey)
    }
    router.navigate(
      `/h/${encodeURIComponent(firstParam(params.hostId))}/session/${encodeURIComponent(launch.worktreeId)}?${query}`
    )
  }

  return (
    <Pressable
      onPress={open}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon size={14} color={colors.textPrimary} />
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    alignSelf: 'flex-start',
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  pressed: { opacity: 0.7 },
  label: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
}))
