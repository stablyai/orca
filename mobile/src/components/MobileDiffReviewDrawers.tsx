import { useMemo } from 'react'
import { KeyboardAvoidingView, View } from 'react-native'
import { Check, Copy, FileText, Minus, Plus, Send, Trash2, X } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { ActionSheetAction } from './ActionSheetModal'
import { ActionSheetContent } from './ActionSheetModal'
import { ConfirmContent } from './ConfirmModal'
import { KeyedBottomDrawer } from './keyed-bottom-drawer'
import { AGENT_LAUNCH_STATUS_UNREADABLE_MESSAGE } from '../session/mobile-existing-agent-launch'
import {
  mobileReviewCountLabel,
  type ComposerState,
  type SendSheetState
} from '../session/mobile-diff-review-screen-model'
import { reviewSheetKey, type ReviewSheet } from '../session/mobile-diff-review-sheets'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { hostOs } from '../platform/host-os'
import { useWorkspaceOnPairedHost } from '../navigation/workspace-execution-host'
import { Button } from './ui/Button'
import { ReplyBox } from './ui/ReplyBox'
import { SheetHeader } from './ui/SheetHeader'

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
  switch (sheet.kind) {
    case 'actions':
      return <ReviewActionsContent controller={controller} />
    case 'send':
      return <SendNotesContent controller={controller} load={sheet.load} />
    case 'discard':
      return (
        <ConfirmContent
          title="Discard changes?"
          message={`Discard changes to "${sheet.target.filePath}"? This cannot be undone.`}
          confirmLabel="Discard"
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

function ReviewActionsContent({ controller }: Props) {
  const overflowActions = useOverflowActions(controller)
  return (
    <ActionSheetContent
      title="Review actions"
      message={
        controller.reviewedUnstagedCount > 0
          ? `${mobileReviewCountLabel(controller.reviewedUnstagedCount, 'reviewed file is', 'reviewed files are')} ready to stage.`
          : undefined
      }
      actions={overflowActions}
      onClose={() => controller.closeSheet('actions')}
    />
  )
}

function SendNotesContent({ controller, load }: Props & { load: SendSheetState }) {
  const sendActions = useSendActions(controller, load)
  return (
    <ActionSheetContent
      title="Send notes"
      message={sendSheetMessage(controller, load)}
      actions={sendActions}
      onClose={() => controller.closeSheet('send')}
    />
  )
}

function useSendActions(
  controller: ReturnType<typeof useMobileDiffReviewController>,
  load: SendSheetState
) {
  return useMemo<ActionSheetAction[]>(() => {
    const comments = controller.unsentComments
    const terminalActions =
      load.kind === 'ready' || load.kind === 'error'
        ? load.terminals.map((terminal) => ({
            label: `${terminal.title || 'Terminal'} (${terminal.terminal.slice(0, 6)})`,
            icon: Send,
            disabled: comments.length === 0,
            skipAutoClose: true,
            onPress: () => void controller.sendPromptToTerminal(terminal.terminal, comments)
          }))
        : []
    return [
      ...terminalActions,
      {
        label: 'New agent session',
        icon: Plus,
        disabled: comments.length === 0 || controller.agentLaunchAvailability !== 'available',
        ...(controller.agentLaunchAvailability === 'update-required'
          ? { hint: 'Update Orca on your computer' }
          : controller.agentLaunchAvailability === 'unverified'
            ? { hint: AGENT_LAUNCH_STATUS_UNREADABLE_MESSAGE }
            : {}),
        skipAutoClose: true,
        onPress: () => void controller.createTerminalAndSend(comments)
      },
      {
        label: 'Copy notes',
        icon: Copy,
        disabled:
          controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes()
      }
    ]
  }, [controller, load])
}

function useOverflowActions(controller: ReturnType<typeof useMobileDiffReviewController>) {
  const sessionTabsAvailable = useWorkspaceOnPairedHost()
  return useMemo<ActionSheetAction[]>(
    () => [
      ...fileGitActions(controller),
      {
        label: 'Copy notes',
        icon: Copy,
        disabled:
          controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes()
      },
      {
        label: 'Send unsent notes',
        icon: Send,
        disabled: controller.unsentComments.length === 0,
        onPress: () => void controller.openSendSheet()
      },
      {
        label: 'Clear sent notes',
        icon: Trash2,
        disabled:
          controller.screenState.kind !== 'ready' ||
          controller.screenState.comments.every((comment) => comment.sentAt === undefined),
        skipAutoClose: true,
        onPress: () => void controller.clearSentNotes()
      },
      {
        label: 'Stage reviewed files',
        icon: Check,
        disabled: controller.reviewedUnstagedCount === 0 || controller.busyAction !== null,
        skipAutoClose: true,
        onPress: () => void controller.stageReviewedFiles()
      },
      {
        label: 'Mark unreviewed',
        icon: X,
        disabled:
          controller.screenState.kind !== 'ready' ||
          !controller.currentItem ||
          !controller.currentItem.isReviewed,
        skipAutoClose: true,
        onPress: () => void controller.markUnreviewed()
      },
      ...(sessionTabsAvailable
        ? [
            {
              label: 'Open in session',
              icon: FileText,
              disabled: !controller.currentItem || controller.currentItem.scope === 'branch',
              onPress: () => void controller.openInSession()
            }
          ]
        : [])
    ],
    [controller, sessionTabsAvailable]
  )
}

// Per-file stage, unstage and discard: kept off the footer so the diff keeps the screen.
function fileGitActions(
  controller: ReturnType<typeof useMobileDiffReviewController>
): ActionSheetAction[] {
  const item = controller.currentItem
  if (!item) {
    return []
  }
  const busy = controller.busyAction !== null
  return [
    ...(item.canStage
      ? [
          {
            label: 'Stage file',
            icon: Plus,
            disabled: busy,
            onPress: () => void controller.runGitMutation('git.stage', item)
          }
        ]
      : []),
    ...(item.canUnstage
      ? [
          {
            label: 'Unstage file',
            icon: Minus,
            disabled: busy,
            onPress: () => void controller.runGitMutation('git.unstage', item)
          }
        ]
      : []),
    ...(item.canDiscard
      ? [
          {
            label: 'Discard file',
            icon: Trash2,
            destructive: true,
            disabled: busy,
            onPress: () => controller.openSheet({ kind: 'discard', target: item })
          }
        ]
      : [])
  ]
}

function sendSheetMessage(
  controller: ReturnType<typeof useMobileDiffReviewController>,
  load: SendSheetState
): string | undefined {
  return load.kind === 'loading'
    ? 'Loading agent sessions…'
    : load.kind === 'error'
      ? load.message
      : `${mobileReviewCountLabel(controller.unsentComments.length, 'unsent note', 'unsent notes')}. Pick where to send them.`
}

function NoteComposerContent({ controller, composer }: Props & { composer: ComposerState }) {
  return (
    <KeyboardAvoidingView behavior={hostOs() === 'ios' ? 'padding' : undefined}>
      <SheetHeader
        title={composer.mode === 'edit' ? 'Edit note' : 'Add note'}
        subtitle={
          composer.mode === 'create' && composer.lineNumber > 0
            ? `Line ${composer.lineNumber}`
            : composer.mode === 'edit' && composer.comment.lineNumber > 0
              ? `Line ${composer.comment.lineNumber}`
              : 'File note'
        }
        leading={{ label: 'Cancel', onPress: controller.closeComposer }}
      />
      <View style={styles.sheetBody}>
        <ReplyBox
          value={controller.composerBody}
          onChangeText={controller.setComposerBody}
          onSend={() => void controller.saveComposer()}
          placeholder="Write a note for the agent…"
          sendAccessibilityLabel={composerLabel(composer)}
          autoFocus
          maxLines={8}
        />
        {composer.mode === 'edit' ? (
          <View style={styles.composerActions}>
            <Button
              label="Delete note"
              icon={Trash2}
              variant="destructive"
              size="compact"
              onPress={() => void controller.deleteComment()}
            />
          </View>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  )
}

function composerLabel(
  composer: { mode: 'create'; lineNumber: number } | { mode: 'edit'; comment: DiffComment } | null
): string {
  return composer?.mode === 'create' && composer.lineNumber > 0
    ? `Save note on line ${composer.lineNumber}`
    : 'Save note'
}

function CompletionContent({ controller }: Props) {
  const noteCount =
    controller.screenState.kind === 'ready' ? controller.screenState.comments.length : 0
  const canSend = controller.unsentComments.length > 0
  const canStage = controller.reviewedUnstagedCount > 0
  return (
    <>
      <SheetHeader
        title="Review complete"
        subtitle={`${mobileReviewCountLabel(controller.queue.length, 'file', 'files')} reviewed, ${mobileReviewCountLabel(noteCount, 'note', 'notes')}`}
        trailing={{ label: 'Done', onPress: () => controller.closeSheet('completion') }}
      />
      <View style={styles.sheetActions}>
        {/* One primary: sending notes when there are any, otherwise staging what was reviewed. */}
        <Button
          label="Send notes"
          icon={Send}
          variant={canSend ? 'primary' : 'secondary'}
          block
          disabled={!canSend}
          onPress={() => void controller.openSendSheet()}
          accessibilityLabel="Send notes to agent"
        />
        <Button
          label="Stage reviewed files"
          icon={Check}
          variant={canSend ? 'secondary' : 'primary'}
          block
          disabled={!canStage}
          onPress={() => void controller.stageReviewedFiles()}
          accessibilityLabel="Stage reviewed files"
        />
      </View>
    </>
  )
}
