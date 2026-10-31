import { useMemo } from 'react'
import { KeyboardAvoidingView, Pressable, Text, View } from 'react-native'
import { Check, Copy, Plus, Send, Trash2, X } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { sendSheetMessage } from './mobile-diff-review-send-copy'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ActionSheetAction } from './ActionSheetModal'
import { ActionSheetContent } from './ActionSheetModal'
import { ConfirmContent } from './ConfirmModal'
import { KeyedBottomDrawer } from './keyed-bottom-drawer'
import type { ComposerState, SendSheetState } from '../session/mobile-diff-review-screen-model'
import { reviewSheetKey, type ReviewSheet } from '../session/mobile-diff-review-sheets'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { MessageBox } from './composer-input/MessageBox'
import { composerInputStyles } from './composer-input/composer-input-styles'
import { hostOs } from '../platform/host-os'

type Props = {
  controller: ReturnType<typeof useMobileDiffReviewController>
}

export function MobileDiffReviewDrawers({ controller }: Props) {
  // One drawer for every review sheet: iOS cannot present a sheet while another is still closing.
  return (
    <KeyedBottomDrawer
      sheet={controller.sheet}
      sheetKey={reviewSheetKey}
      onClose={(presented) => controller.closeSheet(presented.kind)}
    >
      {(presented) => <ReviewSheetContent controller={controller} sheet={presented} />}
    </KeyedBottomDrawer>
  )
}

function ReviewSheetContent({ controller, sheet }: Props & { sheet: ReviewSheet }) {
  const t = useMobileTranslation()
  switch (sheet.kind) {
    case 'send':
      return <SendNotesContent controller={controller} load={sheet.load} />
    case 'discard':
      return (
        <ConfirmContent
          title={t('components.diffReviewDrawers.discardTitle', 'Discard File')}
          message={t(
            'components.diffReviewDrawers.discardMessage',
            'Discard changes to "{{filePath}}"? This cannot be undone.',
            { filePath: sheet.target.filePath }
          )}
          confirmLabel={t('components.diffReviewDrawers.discard', 'Discard')}
          destructive
          onConfirm={() => {
            controller.closeSheet('discard')
            void controller.runGitMutation('git.discard', sheet.target)
          }}
          onCancel={() => controller.closeSheet('discard')}
        />
      )
    case 'composer':
      return <NoteComposerContent controller={controller} composer={sheet.composer} />
    case 'completion':
      return <CompletionContent controller={controller} />
  }
}

function SendNotesContent({ controller, load }: Props & { load: SendSheetState }) {
  const t = useMobileTranslation()
  const sendActions = useSendActions(controller, load)
  return (
    <ActionSheetContent
      title={t('components.diffReviewDrawers.sendNotes', 'Send Notes')}
      message={sendSheetMessage(t, controller, load)}
      actions={sendActions}
      onClose={() => controller.closeSheet('send')}
    />
  )
}

function useSendActions(
  controller: ReturnType<typeof useMobileDiffReviewController>,
  load: SendSheetState
) {
  const t = useMobileTranslation()
  return useMemo<ActionSheetAction[]>(() => {
    const comments = controller.unsentComments
    const terminalActions =
      load.kind === 'ready' || load.kind === 'error'
        ? load.terminals.map((terminal) => ({
            id: `terminal:${terminal.terminal}`,
            label: t('components.diffReviewDrawers.terminalLabel', '{{title}} ({{id}})', {
              title: terminal.title || t('components.diffReviewDrawers.terminal', 'Terminal'),
              id: terminal.terminal.slice(0, 6)
            }),
            icon: Send,
            disabled: comments.length === 0,
            skipAutoClose: true,
            onPress: () => void controller.sendPromptToTerminal(terminal.terminal, comments)
          }))
        : []
    return [
      ...terminalActions,
      {
        id: 'newAgentSession',
        label: t('components.diffReviewDrawers.newAgentSession', 'New Agent Session'),
        icon: Plus,
        disabled: comments.length === 0 || controller.agentLaunchAvailability !== 'available',
        ...(controller.agentLaunchAvailability === 'update-required'
          ? {
              hint: t('components.diffReviewDrawers.updateRequired', 'Update Orca on your computer')
            }
          : controller.agentLaunchAvailability === 'unverified'
            ? {
                hint: t(
                  'components.diffReviewDrawers.statusUnreadable',
                  "Could not read this host's status. Retrying…"
                )
              }
            : {}),
        skipAutoClose: true,
        onPress: () => void controller.createTerminalAndSend(comments)
      },
      {
        id: 'copyNotes',
        label: t('components.diffReviewDrawers.copyNotes', 'Copy Notes'),
        icon: Copy,
        disabled:
          controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes()
      }
    ]
  }, [controller, load, t])
}

function NoteComposerContent({ controller, composer }: Props & { composer: ComposerState }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <KeyboardAvoidingView behavior={hostOs() === 'ios' ? 'padding' : undefined}>
      <View style={styles.composerHeader}>
        <View>
          <Text style={styles.drawerTitle}>
            {composer.mode === 'edit'
              ? t('components.diffReviewDrawers.editNote', 'Edit Note')
              : t('components.diffReviewDrawers.addNote', 'Add Note')}
          </Text>
          <Text style={styles.drawerSubtitle}>
            {composer.mode === 'create' && composer.lineNumber > 0
              ? t('components.diffReviewDrawers.lineNumber', 'Line {{lineNumber}}', {
                  lineNumber: composer.lineNumber
                })
              : t('components.diffReviewDrawers.fileNote', 'File note')}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          onPress={controller.closeComposer}
          accessibilityRole="button"
          accessibilityLabel={t('components.diffReviewDrawers.cancelNote', 'Cancel note')}
        >
          <X size={18} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      </View>
      <MessageBox
        value={controller.composerBody}
        onChangeText={controller.setComposerBody}
        autoFocus
        placeholder={t('components.diffReviewDrawers.reviewNote', 'Review note')}
        accessibilityLabel={composerLabel(t, composer)}
        onSend={() => void controller.saveComposer()}
        sendAccessibilityLabel={saveLabel(t, composer)}
        leading={
          composer.mode === 'edit' ? <DeleteNoteButton onPress={controller.deleteComment} /> : null
        }
      />
    </KeyboardAvoidingView>
  )
}

function composerLabel(
  t: Translate,
  composer: { mode: 'create'; lineNumber: number } | { mode: 'edit'; comment: DiffComment } | null
): string {
  return composer?.mode === 'create' && composer.lineNumber > 0
    ? t('components.diffReviewDrawers.saveLineNote', 'Save note on line {{lineNumber}}', {
        lineNumber: composer.lineNumber
      })
    : t('components.diffReviewDrawers.reviewNote', 'Review note')
}

function saveLabel(t: Translate, composer: ComposerState): string {
  return composer.mode === 'create' && composer.lineNumber > 0
    ? composerLabel(t, composer)
    : t('session.diffLineRow.saveNote', 'Save note')
}

function DeleteNoteButton({ onPress }: { onPress: () => Promise<void> }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Pressable
      style={({ pressed }) => [
        composerInputStyles.ghostButton,
        pressed && composerInputStyles.pressed
      ]}
      onPress={() => void onPress()}
      accessibilityRole="button"
      accessibilityLabel={t('components.diffReviewDrawers.deleteNote', 'Delete note')}
    >
      <Trash2 size={18} color={colors.statusRed} strokeWidth={2} />
    </Pressable>
  )
}

function CompletionContent({ controller }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const fileCount = controller.queue.length
  const count = controller.screenState.kind === 'ready' ? controller.screenState.comments.length : 0
  return (
    <>
      <Text style={styles.drawerTitle}>
        {t('components.diffReviewDrawers.completeTitle', 'Review Complete')}
      </Text>
      <Text style={styles.drawerSubtitle}>
        {fileCount === 1
          ? count === 1
            ? t(
                'components.diffReviewDrawers.fileSummary_one',
                '{{fileCount}} file reviewed, {{count}} note',
                { fileCount, count }
              )
            : t(
                'components.diffReviewDrawers.fileSummary_other',
                '{{fileCount}} file reviewed, {{count}} notes',
                { fileCount, count }
              )
          : count === 1
            ? t(
                'components.diffReviewDrawers.filesSummary_one',
                '{{fileCount}} files reviewed, {{count}} note',
                { fileCount, count }
              )
            : t(
                'components.diffReviewDrawers.filesSummary_other',
                '{{fileCount}} files reviewed, {{count}} notes',
                { fileCount, count }
              )}
      </Text>
      <View style={styles.drawerButtonRow}>
        <Pressable
          style={({ pressed }) => [
            styles.secondaryButton,
            styles.sheetSecondaryButton,
            pressed && styles.buttonPressed
          ]}
          disabled={controller.reviewedUnstagedCount === 0}
          onPress={() => void controller.stageReviewedFiles()}
          accessibilityRole="button"
          accessibilityLabel={t(
            'components.diffReviewDrawers.stageReviewedLabel',
            'Stage reviewed files'
          )}
        >
          <Check size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.secondaryButtonText}>
            {t('components.diffReviewDrawers.stageReviewed', 'Stage Reviewed')}
          </Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
          disabled={controller.unsentComments.length === 0}
          onPress={() => void controller.openSendSheet()}
          accessibilityRole="button"
          accessibilityLabel={t(
            'components.diffReviewDrawers.sendNotesLabel',
            'Send notes to agent'
          )}
        >
          <Send size={14} color={colors.bgBase} strokeWidth={2.2} />
          <Text style={styles.primaryButtonText}>
            {t('components.diffReviewDrawers.sendNotes', 'Send Notes')}
          </Text>
        </Pressable>
      </View>
    </>
  )
}
