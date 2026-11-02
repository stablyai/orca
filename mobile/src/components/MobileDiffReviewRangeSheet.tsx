import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Pressable, Text, View } from 'react-native'
import { Sparkles } from 'lucide-react-native'
import { getRuntimePathBasename } from '../../../src/shared/cross-platform-path'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { hostOs } from '../platform/host-os'
import { canCommentOnGitHub } from '../session/mobile-diff-review-github'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { TextField } from './composer-input/TextField'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { SheetHeader } from './nav-bar/SheetHeader'
import type { ReviewSheet } from '../session/mobile-diff-review-sheets'
import type { MobileReviewTerminalTab } from '../session/review-terminal-reply-schema'

type Props = {
  controller: ReturnType<typeof useMobileDiffReviewController>
}

// Lines picked in the diff: a note for the workspace's agent, or a comment straight on GitHub.
export function MobileDiffReviewRangeSheet({
  controller,
  range
}: Props & { range: Extract<ReviewSheet, { kind: 'range' }> }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const item = controller.currentItem
  const { agentName, terminals } = useAgentTerminals(controller)
  const [busy, setBusy] = useState<'github' | 'agent' | null>(null)
  const [postError, setPostError] = useState<string | null>(null)
  const body = controller.composerBody.trim()
  const onGitHub = canCommentOnGitHub(controller.github, item, range)
  const title =
    range.startLine === range.line
      ? t('components.diffReviewDrawers.rangeLine', 'Line {{line}}', { line: range.line })
      : t('components.diffReviewDrawers.rangeLines', 'Lines {{startLine}}–{{line}}', {
          startLine: range.startLine,
          line: range.line
        })
  const sendLabel = agentName
    ? t('components.diffReviewDrawers.sendToAgent', 'Send to {{agent}}', { agent: agentName })
    : t('components.diffReviewDrawers.sendToAnAgent', 'Send to agent')
  return (
    <KeyboardAvoidingView behavior={hostOs() === 'ios' ? 'padding' : undefined}>
      <SheetHeader
        title={title}
        {...(item ? { subtitle: getRuntimePathBasename(item.filePath) } : {})}
        trailing={{
          label: t('common.cancel', 'Cancel'),
          onPress: () => controller.closeSheet('range', range)
        }}
      />
      <TextField
        value={controller.composerBody}
        onChangeText={controller.setComposerBody}
        autoFocus
        multiline
        placeholder={t('components.diffReviewDrawers.rangePlaceholder', 'What should change here?')}
        accessibilityLabel={title}
        style={styles.rangeField}
      />
      {postError ? <Text style={styles.rangeError}>{postError}</Text> : null}
      <View style={styles.drawerButtonRow}>
        {onGitHub && item ? (
          <Pressable
            style={({ pressed }) => [
              styles.secondaryButton,
              styles.sheetSecondaryButton,
              (busy !== null || !body) && styles.buttonDisabled,
              pressed && styles.buttonPressed
            ]}
            disabled={busy !== null || !body}
            onPress={() => {
              setBusy('github')
              setPostError(null)
              void controller
                .commentOnGitHub({ item, startLine: range.startLine, line: range.line, body })
                .then((posted) => {
                  if (posted.ok) {
                    // Only this sheet; one opened since keeps its own draft.
                    controller.closeSheet('range', range)
                  } else {
                    setPostError(posted.error)
                  }
                })
                .finally(() => setBusy(null))
            }}
            accessibilityRole="button"
            accessibilityLabel={t(
              'components.diffReviewDrawers.commentOnGitHub',
              'Comment on GitHub'
            )}
          >
            <Text style={styles.secondaryButtonText}>
              {t('components.diffReviewDrawers.commentOnGitHub', 'Comment on GitHub')}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [
            styles.primaryButton,
            (busy !== null || !body) && styles.buttonDisabled,
            pressed && styles.buttonPressed
          ]}
          disabled={busy !== null || !body}
          onPress={() => {
            setBusy('agent')
            setPostError(null)
            void controller
              .sendRange(range, terminals ?? undefined)
              .then(setPostError)
              .finally(() => setBusy(null))
          }}
          accessibilityRole="button"
          accessibilityLabel={sendLabel}
        >
          <Sparkles size={16} color={colors.bgBase} strokeWidth={2.2} />
          <Text style={styles.primaryButtonText} numberOfLines={1}>
            {sendLabel}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

// The workspace's terminals, listed once per sheet: Send reuses them, and names the button after the one agent.
function useAgentTerminals(controller: ReturnType<typeof useMobileDiffReviewController>) {
  const [terminals, setTerminals] = useState<readonly MobileReviewTerminalTab[] | null>(null)
  const loadTerminals = controller.loadTerminals
  useEffect(() => {
    let active = true
    void loadTerminals()
      .then((listed) => {
        if (active) {
          setTerminals(listed)
        }
      })
      // The button still works without a name; sending lists terminals again and reports its own failure.
      .catch(() => {})
    return () => {
      active = false
    }
  }, [loadTerminals])
  const agents = terminals?.filter((terminal) => terminal.agent !== undefined) ?? []
  const [only] = agents
  const agentName =
    agents.length === 1 && only?.agent ? (tuiAgentDisplayName(only.agent) ?? only.title) : null
  return { agentName, terminals }
}
