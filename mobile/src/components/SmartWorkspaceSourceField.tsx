import { Text, TextInput, View } from 'react-native'
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
import { colors } from '../theme/mobile-theme'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import { TaskProviderLogo } from './TaskProviderLogo'
import { IconButton } from './ui/IconButton'
import { LIST_LEADING_INSET, ListGroup } from './ui/ListGroup'
import { ListRow } from './ui/ListRow'
import { SectionHeader } from './ui/SectionHeader'

type Props = {
  composer: MobileComposerSource
  label: string
  disabled?: boolean
  onOpenExternalUrl: (url: string) => void
  // Why: only the active form view may focus this field. While the source drawer
  // is open/closing this stays non-focusable so the drawer's dismiss (which
  // restores native focus back here) can't re-fire onFocus and reopen the drawer.
  interactive: boolean
  onBeforeOpen?: () => void
  onOpenDrawer: () => void
}

const SOURCE_ICON_SIZE = 18

export function SmartWorkspaceSourceKindIcon({ kind }: { kind: SmartNameSelection['kind'] }) {
  const color = colors.textSecondary
  switch (kind) {
    case 'github-pr':
      return <GitPullRequest size={SOURCE_ICON_SIZE} color={color} />
    case 'gitlab-mr':
      return <GitMerge size={SOURCE_ICON_SIZE} color={color} />
    case 'github-issue':
    case 'gitlab-issue':
      return <CircleDot size={SOURCE_ICON_SIZE} color={color} />
    case 'branch':
      return <GitBranch size={SOURCE_ICON_SIZE} color={color} />
    case 'jira':
      return <TaskProviderLogo provider="jira" size={SOURCE_ICON_SIZE} color={color} />
    case 'linear':
      return <TaskProviderLogo provider="linear" size={SOURCE_ICON_SIZE} color={color} />
  }
}

/** The form's "Start from" group: a name, or the source a workspace is created from. */
export function SmartWorkspaceSourceField({
  composer,
  label,
  disabled,
  onOpenExternalUrl,
  interactive,
  onBeforeOpen,
  onOpenDrawer
}: Props) {
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
      <View style={styles.bleed}>
        <SectionHeader title={label} action={<Text style={styles.optional}>Optional</Text>} />
      </View>
      <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
        {selection ? (
          <ListRow
            title={selection.label}
            leading={<SmartWorkspaceSourceKindIcon kind={selection.kind} />}
            accessory={
              <View style={styles.sourceActions}>
                {selection.url ? (
                  <IconButton
                    icon={ExternalLink}
                    variant="bare"
                    iconSize={18}
                    iconColor={colors.textSecondary}
                    accessibilityLabel="Open selected source"
                    onPress={() => {
                      if (selection.url) {
                        onOpenExternalUrl(selection.url)
                      }
                    }}
                  />
                ) : null}
                <IconButton
                  icon={X}
                  variant="bare"
                  iconSize={18}
                  iconColor={colors.textSecondary}
                  accessibilityLabel="Clear selected source"
                  onPress={composer.handleClearSmartNameSelection}
                />
              </View>
            }
          />
        ) : (
          // Why: real TextInput (not a Pressable fake) so the typed value is the
          // same composer.name the source drawer docks — focus handoff keeps the
          // string continuous even though native focus moves to the docked field.
          <TextInput
            style={[styles.inputRow, disabled && styles.disabledRow]}
            value={composer.name}
            onChangeText={composer.setName}
            onFocus={openDrawer}
            editable={!disabled && interactive}
            placeholder="Type a name or search a source"
            placeholderTextColor={colors.textMuted}
            selectionColor={colors.accentBlue}
            accessibilityLabel={label}
            autoCapitalize="none"
            autoCorrect={false}
            // Why: form field is a portal into the picker; return should not
            // submit the create form while the drawer is about to open.
            blurOnSubmit={false}
            showSoftInputOnFocus={false}
          />
        )}
      </ListGroup>
    </>
  )
}
