// Import's "Another app…": copy the message that asks the old bot to copy its own files to Downloads, then give
// the new bot the folder it made on the bot's computer; its reply goes with the name. The desktop's ImportBotExportFields.
import { useState } from 'react'
import { Pressable, Text } from 'react-native'
import { ChevronDown, Copy, Folder, FolderPlus, MessageSquareText, X } from 'lucide-react-native'
import { DisclosureChevron } from '../components/list/DisclosureChevron'
import { LIST_LEADING_INSET, LIST_ROW_PADDING, ListRow } from '../components/list/ListGroup'
import { ListStepMark } from '../components/list/ListStepMark'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { getRuntimePathBasename } from '../../../src/shared/file-access/cross-platform-path'
import { BOT_IMPORT_EXPORT_PROMPT } from '../../../src/shared/bots/bot-import'
import type { ExportFolder } from './MobileBotExportFolderPage'

export function MobileBotImportExportSteps(props: {
  /** The computer was read and had no other-app bots. */
  noneFound: boolean
  copied: boolean
  onCopy: () => void
  folder: ExportFolder | null
  onRemoveFolder: () => void
  /** Null while the computer can't be reached. */
  onChooseFolder: (() => void) | null
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const [seeMessage, setSeeMessage] = useState(false)
  const { copied, folder } = props
  return (
    <>
      {props.noneFound ? (
        <SettingsNote>
          {t(
            'bots.import.noneFoundNote',
            'No bots found in OpenClaw (~/.openclaw), Hermes (~/.hermes) or OpenBot.'
          )}
        </SettingsNote>
      ) : null}
      <SettingsSection separatorInset={LIST_LEADING_INSET}>
        <ListRow
          key="send"
          leading={<ListStepMark n={1} done={copied} />}
          title={t('bots.import.sendStep', 'Send your old bot this message')}
          wrapTitle
        />
        <ListRow
          key="copy"
          leading={<Copy size={18} color={colors.textPrimary} />}
          title={
            copied
              ? t('bots.import.copyAgain', 'Copy again')
              : t('bots.import.copyMessage', 'Copy message')
          }
          onPress={props.onCopy}
        />
        <ListRow
          key="see"
          leading={<MessageSquareText size={18} color={colors.textPrimary} />}
          title={t('bots.import.seeMessage', 'See the message')}
          accessory={
            <DisclosureChevron expanded={seeMessage} collapsedDeg={0} expandedDeg={180}>
              <ChevronDown size={15} color={colors.textMuted} strokeWidth={2.2} />
            </DisclosureChevron>
          }
          onPress={() => setSeeMessage(!seeMessage)}
        />
        {seeMessage ? (
          <Text key="message" style={styles.prompt} selectable>
            {BOT_IMPORT_EXPORT_PROMPT}
          </Text>
        ) : null}
        <ListRow
          key="add"
          leading={<ListStepMark n={2} done={folder !== null} />}
          title={t('bots.import.addStep', 'Add the folder it made')}
          wrapTitle
        />
        {folder ? (
          <ListRow
            key="folder"
            leading={<Folder size={18} color={colors.textSecondary} />}
            title={folder.shown}
            subtitle={
              folder.count === 1
                ? t('bots.import.folderItems_one', '{{count}} item', { count: folder.count })
                : t('bots.import.folderItems_other', '{{count}} items', { count: folder.count })
            }
            accessory={
              <Pressable
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={t('bots.import.removePath', 'Remove {{name}}', {
                  name: getRuntimePathBasename(folder.path)
                })}
                onPress={props.onRemoveFolder}
                style={({ pressed }) => pressed && styles.pressed}
              >
                <X size={16} color={colors.textMuted} />
              </Pressable>
            }
          />
        ) : null}
        <ListRow
          key="choose"
          leading={<FolderPlus size={18} color={colors.textPrimary} />}
          title={
            folder
              ? t('bots.import.chooseAnother', 'Choose another folder…')
              : t('bots.import.chooseFolderRow', 'Choose a folder…')
          }
          navigates
          disabled={props.onChooseFolder === null}
          {...(props.onChooseFolder ? { onPress: props.onChooseFolder } : {})}
        />
      </SettingsSection>
    </>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  // Under its row's title, as a subtitle sits.
  prompt: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
    paddingLeft: LIST_LEADING_INSET,
    paddingRight: LIST_ROW_PADDING,
    paddingVertical: spacing.md
  },
  pressed: { opacity: 0.6 }
}))
