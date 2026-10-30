import { Pressable, Text, View } from 'react-native'
import {
  CircleDot,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  X
} from 'lucide-react-native'
import type { SmartNameSelection } from '../tasks/mobile-composer-source-types'
import type { MobileComposerSource } from '../tasks/use-mobile-composer-source'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { TaskProviderLogo } from './TaskProviderLogo'
import { TextField } from './composer-input/TextField'

type Props = {
  composer: MobileComposerSource
  label: string
  disabled?: boolean
  onOpenExternalUrl: (url: string) => void
  // Disable form focus while drawer opens/closes; native focus restoration must not reopen it via onFocus.
  interactive: boolean
  onBeforeOpen?: () => void
  onOpenDrawer: () => void
}

function SelectionIcon({ kind }: { kind: SmartNameSelection['kind'] }) {
  useMobileColorScheme()
  if (kind === 'github-pr') {
    return <GitPullRequest size={15} color={colors.textSecondary} />
  }
  if (kind === 'gitlab-mr') {
    return <GitMerge size={15} color={colors.textSecondary} />
  }
  if (kind === 'github-issue' || kind === 'gitlab-issue') {
    return <CircleDot size={15} color={colors.textSecondary} />
  }
  if (kind === 'branch') {
    return <GitBranch size={15} color={colors.textSecondary} />
  }
  return <TaskProviderLogo provider="linear" size={15} color={colors.textSecondary} />
}

export function SmartWorkspaceSourceField({
  composer,
  label,
  disabled,
  onOpenExternalUrl,
  interactive,
  onBeforeOpen,
  onOpenDrawer
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const selection = composer.smartNameSelection

  function openDrawer(): void {
    if (disabled) {
      return
    }
    onBeforeOpen?.()
    onOpenDrawer()
  }

  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}{' '}
        <Text style={styles.labelHint}>
          {t('components.smartWorkspaceSourceField.optional', '[Optional]')}
        </Text>
      </Text>
      {selection ? (
        <View style={styles.pill}>
          <SelectionIcon kind={selection.kind} />
          <Text style={styles.pillLabel} numberOfLines={1}>
            {selection.label}
          </Text>
          {selection.url ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t(
                'components.smartWorkspaceSourceField.openSelectedSource',
                'Open selected source'
              )}
              hitSlop={6}
              onPress={() => {
                if (selection.url) {
                  onOpenExternalUrl(selection.url)
                }
              }}
            >
              <ExternalLink size={15} color={colors.textMuted} />
            </Pressable>
          ) : null}
          <Pressable hitSlop={6} onPress={composer.handleClearSmartNameSelection}>
            <X size={15} color={colors.textMuted} />
          </Pressable>
        </View>
      ) : (
        // Use real TextInput sharing composer.name with docked picker field so typed text survives native focus handoff.
        <TextField
          // A non-interactive sheet is mid-swap, not disabled, so it stays undimmed.
          style={disabled ? undefined : styles.enabled}
          value={composer.name}
          onChangeText={composer.setName}
          onFocus={openDrawer}
          editable={!disabled && interactive}
          placeholder={t(
            'components.smartWorkspaceSourceField.searchPlaceholder',
            'Type a name or search a source'
          )}
          autoCapitalize="none"
          autoCorrect={false}
          // Return opens picker, never submits create form during focus handoff.
          blurOnSubmit={false}
          showSoftInputOnFocus={false}
        />
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  field: {
    marginBottom: spacing.md
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: spacing.xs
  },
  labelHint: {
    fontWeight: '400',
    color: colors.textMuted
  },
  enabled: {
    opacity: 1
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  pillLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  }
}))
