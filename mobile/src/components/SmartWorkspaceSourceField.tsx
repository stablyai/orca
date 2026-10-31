import { Pressable, View } from 'react-native'
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
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { TaskProviderLogo } from './TaskProviderLogo'
import { TextField } from './composer-input/TextField'
import { LIST_LEADING_INSET, ListGroup } from './list/ListGroup'
import { ListRow } from './list/ListRow'
import { SectionHeader } from './list/SectionHeader'

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
    return <GitPullRequest size={18} color={colors.textSecondary} />
  }
  if (kind === 'gitlab-mr') {
    return <GitMerge size={18} color={colors.textSecondary} />
  }
  if (kind === 'github-issue' || kind === 'gitlab-issue') {
    return <CircleDot size={18} color={colors.textSecondary} />
  }
  if (kind === 'branch') {
    return <GitBranch size={18} color={colors.textSecondary} />
  }
  return <TaskProviderLogo provider="linear" size={18} color={colors.textSecondary} />
}

/** The form's "Start from" section: a name, or the source a workspace is created from. */
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
    <>
      <SectionHeader
        title={label}
        trailing={t('components.smartWorkspaceSourceField.optionalLabel', 'Optional')}
      />
      {selection ? (
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          <ListRow
            key="selection"
            title={selection.label}
            leading={<SelectionIcon kind={selection.kind} />}
            accessory={
              <View style={styles.actions}>
                {selection.url ? (
                  <Pressable
                    style={styles.action}
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
                    <ExternalLink size={17} color={colors.textSecondary} />
                  </Pressable>
                ) : null}
                <Pressable
                  style={styles.action}
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    'components.smartWorkspaceSourceField.clearSelectedSource',
                    'Clear selected source'
                  )}
                  hitSlop={6}
                  onPress={composer.handleClearSmartNameSelection}
                >
                  <X size={17} color={colors.textSecondary} />
                </Pressable>
              </View>
            }
          />
        </ListGroup>
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
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
          // Return opens picker, never submits create form during focus handoff.
          blurOnSubmit={false}
          showSoftInputOnFocus={false}
        />
      )}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  enabled: {
    opacity: 1
  },
  // The 36 pt hit boxes reach into the row's padding so the glyphs line up with its edge.
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: -spacing.sm
  },
  action: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  }
}))
