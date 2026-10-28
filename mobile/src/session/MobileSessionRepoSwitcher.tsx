import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { themedStyleSheet } from '../theme/themed-styles'
import { Check, ChevronDown } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { styles as sessionStyles } from './mobile-session-styles'
import { useMultiRepoSessionSiblings } from './use-multi-repo-session-siblings'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref
} from '../navigation/workspace-execution-host'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileSessionRepoSwitcher({
  controller,
  title
}: {
  controller: MobileSessionController
  title: string
}) {
  const { client, connState, hostCapabilities, hostId, router, worktreeId } = controller
  const executionHost = useWorkspaceExecutionHost()
  const siblings = useMultiRepoSessionSiblings({ client, connState, hostCapabilities, worktreeId })
  const [open, setOpen] = useState(false)

  if (!siblings || executionHost !== undefined) {
    return (
      <Text style={sessionStyles.sessionTitle} numberOfLines={1}>
        {title}
      </Text>
    )
  }
  const label = siblings.currentMemberName
    ? `${siblings.workspaceName} / ${siblings.currentMemberName}`
    : siblings.workspaceName
  return (
    <>
      <Pressable
        style={localStyles.trigger}
        accessibilityRole="button"
        accessibilityLabel={`${label}, switch repo`}
        onPress={() => setOpen(true)}
      >
        <Text style={[sessionStyles.sessionTitle, localStyles.title]} numberOfLines={1}>
          {label}
        </Text>
        <ChevronDown size={14} color={colors.textSecondary} />
      </Pressable>
      <BottomDrawer visible={open} onClose={() => setOpen(false)}>
        <Text style={localStyles.heading}>{siblings.workspaceName}</Text>
        {siblings.destinations.map((destination) => (
          <Pressable
            key={destination.key}
            style={({ pressed }) => [localStyles.option, pressed && localStyles.pressed]}
            accessibilityRole="button"
            accessibilityState={{ selected: destination.current }}
            onPress={() => {
              setOpen(false)
              if (destination.current || !hostId) {
                return
              }
              const name = destination.label === 'All' ? siblings.workspaceName : destination.label
              router.replace(
                workspaceRouteHref(
                  `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(destination.worktreeId)}?name=${encodeURIComponent(name)}`,
                  executionHost
                )
              )
            }}
          >
            <Text style={localStyles.optionText}>{destination.label}</Text>
            {destination.current ? <Check size={16} color={colors.textPrimary} /> : <View />}
          </Pressable>
        ))}
      </BottomDrawer>
    </>
  )
}

const localStyles = themedStyleSheet(() => ({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28 },
  title: { flexShrink: 1 },
  heading: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    paddingBottom: spacing.sm,
    fontWeight: '600'
  },
  option: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  optionText: { fontSize: typography.bodySize, color: colors.textPrimary },
  pressed: { opacity: 0.7 }
}))
