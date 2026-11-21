// Import's "Another app…": copy the message that asks the old bot to copy its own files to Downloads, then give
// the new bot the folder it made on the bot's computer, and its reply if it wrote one. The desktop's ImportBotExportFields.
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check, Folder, FolderPlus, X } from 'lucide-react-native'
import { MessageBox } from '../components/composer-input/MessageBox'
import { LIST_LEADING_INSET, ListGroup, ListRow } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { getRuntimePathBasename } from '../../../src/shared/file-access/cross-platform-path'
import { BOT_IMPORT_EXPORT_PROMPT, BOT_IMPORT_REPLY_MAX } from '../../../src/shared/bots/bot-import'
import type { ExportFolder } from './MobileBotExportFolderPage'
import { MobileBotTextButton } from './MobileBotTextButton'

function StepMark({ n, done }: { n: number; done: boolean }) {
  return (
    <View style={[styles.step, done && styles.stepDone]}>
      {done ? (
        <Check size={13} color={colors.bgBase} strokeWidth={3} />
      ) : (
        <Text style={styles.stepNumber}>{n}</Text>
      )}
    </View>
  )
}

export function MobileBotImportExportSteps(props: {
  hostLabel: string
  /** The computer was read and had no other-app bots. */
  noneFound: boolean
  copied: boolean
  onCopy: () => void
  folder: ExportFolder | null
  onRemoveFolder: () => void
  /** Null while the computer can't be reached. */
  onChooseFolder: (() => void) | null
  reply: string
  onReply: (reply: string) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [seeMessage, setSeeMessage] = useState(false)
  const { copied, folder } = props
  return (
    <>
      {props.noneFound ? (
        <Text style={styles.note}>
          {t(
            'bots.import.noneFoundNote',
            'No bots found in OpenClaw (~/.openclaw), Hermes (~/.hermes) or OpenBot.'
          )}
        </Text>
      ) : null}
      <ListGroup style={styles.steps} separatorInset={LIST_LEADING_INSET}>
        <ListRow
          key="send"
          leading={<StepMark n={1} done={copied} />}
          title={t('bots.import.sendStep', 'Send your old bot this message')}
          subtitleLines={0}
          {...(copied
            ? {
                subtitle: t(
                  'bots.import.copiedNote',
                  'Copied. Paste it to your old bot wherever you chat with it.'
                )
              }
            : {})}
          detail={
            <View>
              <View style={styles.actions}>
                <MobileBotTextButton
                  label={
                    copied
                      ? t('bots.import.copyAgain', 'Copy again')
                      : t('bots.import.copyMessage', 'Copy message')
                  }
                  onPress={props.onCopy}
                />
                <MobileBotTextButton
                  label={t('bots.import.seeMessage', 'See the message')}
                  onPress={() => setSeeMessage(!seeMessage)}
                />
              </View>
              {seeMessage ? (
                <Text style={styles.prompt} selectable>
                  {BOT_IMPORT_EXPORT_PROMPT}
                </Text>
              ) : null}
            </View>
          }
        />
        <ListRow
          key="add"
          leading={<StepMark n={2} done={folder !== null} />}
          title={t('bots.import.addStep', 'Add the folder it made')}
          subtitle={t(
            'bots.import.addStepNote',
            'It saves a folder ending in -export in Downloads on {{host}}.',
            { host: props.hostLabel }
          )}
          subtitleLines={0}
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
          leading={<FolderPlus size={18} color={colors.textSecondary} />}
          title={
            folder
              ? t('bots.import.chooseAnother', 'Choose another folder…')
              : t('bots.import.chooseFolderRow', 'Choose a folder…')
          }
          navigates
          disabled={props.onChooseFolder === null}
          {...(props.onChooseFolder ? { onPress: props.onChooseFolder } : {})}
        />
      </ListGroup>
      {folder ? (
        <MessageBox
          value={props.reply}
          onChangeText={props.onReply}
          maxLength={BOT_IMPORT_REPLY_MAX}
          placeholder={t('bots.import.replyPlaceholder', 'Paste its reply, if it wrote one')}
          accessibilityLabel={t('bots.import.replyLabel', 'Its reply')}
          style={styles.reply}
        />
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  note: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  steps: { marginTop: spacing.md },
  step: {
    width: 22,
    height: 22,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  stepDone: { backgroundColor: colors.textPrimary },
  stepNumber: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  actions: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs },
  prompt: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    marginBottom: spacing.sm
  },
  reply: { marginTop: spacing.md },
  pressed: { opacity: 0.6 }
}))
