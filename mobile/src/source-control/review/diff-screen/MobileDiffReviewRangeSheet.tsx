import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Text, View } from 'react-native'
import { GitPullRequest, Sparkles } from 'lucide-react-native'
import { getRuntimePathBasename } from '../../../../../src/shared/file-access/cross-platform-path'
import { tuiAgentDisplayName } from '../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import type { DiffHunkLine } from '../../../../../src/shared/github/comments/pr-comment-diff-hunk'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { hostOs } from '../../../platform/host-os'
import { canCommentOnGitHub } from '../diff-actions/mobile-diff-review-github'
import type { useMobileDiffReviewController } from '../use-mobile-diff-review-controller'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { TextField } from '../../../components/composer-input/TextField'
import { ListGroup, ListRow, SectionHeader } from '../../../components/list/ListGroup'
import { MobileAgentIcon } from '../../../components/icons/MobileAgentIcon'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { prSheetStyles } from '../pull-request/pr-tab-styles'
import { PrThreadCode } from '../pull-request/comments/PrThreadCode'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import type { ReviewSheet } from '../diff-actions/mobile-diff-review-sheets'
import type { MobileReviewTerminalTab } from '../terminal-delivery/review-terminal-reply-schema'

type Props = {
  controller: ReturnType<typeof useMobileDiffReviewController>
}

// Enough of the picked lines to recognise them; the diff under the sheet shows the rest.
const MAX_QUOTED_LINES = 6

// The picked lines' one comment sheet: a note for the workspace's agent, or a comment on the pull request.
export function MobileDiffReviewRangeSheet({
  controller,
  range
}: Props & { range: Extract<ReviewSheet, { kind: 'range' }> }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const item = controller.currentItem
  const { agent, agentName, terminals } = useAgentTerminals(controller)
  const [destination, setDestination] = useState<'agent' | 'github'>('agent')
  const [busy, setBusy] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const body = controller.composerBody.trim()
  const onGitHub = canCommentOnGitHub(controller.github, item, range) && item !== null
  const toGitHub = onGitHub && destination === 'github'
  const title =
    range.startLine === range.line
      ? t('components.diffReviewDrawers.rangeLine', 'Line {{line}}', { line: range.line })
      : t('components.diffReviewDrawers.rangeLines', 'Lines {{startLine}}–{{line}}', {
          startLine: range.startLine,
          line: range.line
        })
  const send = () => {
    setBusy(true)
    setPostError(null)
    const sent =
      toGitHub && item
        ? controller
            .commentOnGitHub({ item, startLine: range.startLine, line: range.line, body })
            .then((posted) => {
              if (!posted.ok) {
                return posted.error
              }
              controller.clearSavedNote(body)
              // Only this sheet; text typed since stays.
              controller.closeSheet('range', range)
              return null
            })
        : controller.sendRange(range, terminals ?? undefined)
    void sent
      .then((error) => {
        if (error) {
          setPostError(error)
        } else {
          controller.selectLines(null)
        }
      })
      .finally(() => setBusy(false))
  }
  return (
    <KeyboardAvoidingView behavior={hostOs() === 'ios' ? 'padding' : undefined}>
      <SheetHeader
        title={title}
        {...(item ? { subtitle: getRuntimePathBasename(item.filePath) } : {})}
        leading={{
          label: t('common.cancel', 'Cancel'),
          onPress: () => controller.closeSheet('range', range)
        }}
        trailing={{
          label: t('components.diffReviewDrawers.send', 'Send'),
          onPress: send,
          busy,
          disabled: !body
        }}
      />
      <View style={prSheetStyles.body}>
        <PrThreadCode lines={quotedLines(controller, range)} />
        <TextField
          value={controller.composerBody}
          onChangeText={controller.setComposerBody}
          autoFocus
          multiline
          placeholder={t(
            'components.diffReviewDrawers.rangePlaceholder',
            'What should change here?'
          )}
          accessibilityLabel={title}
          style={styles.rangeField}
        />
        {postError ? <Text style={prSheetStyles.error}>{postError}</Text> : null}
        {onGitHub ? (
          <View>
            <SectionHeader title={t('components.diffReviewDrawers.sendTo', 'Send to')} first />
            <ListGroup>
              <ListRow
                leading={
                  agent ? (
                    <MobileAgentIcon agentId={agent} size={18} />
                  ) : (
                    <Sparkles size={18} color={colors.textSecondary} strokeWidth={2} />
                  )
                }
                title={
                  agentName
                    ? t(
                        'components.diffReviewDrawers.agentInWorkspace',
                        '{{agent}} in this workspace',
                        {
                          agent: agentName
                        }
                      )
                    : t(
                        'components.diffReviewDrawers.anAgentInWorkspace',
                        'Agent in this workspace'
                      )
                }
                selected={destination === 'agent'}
                accessibilityRole="radio"
                onPress={() => setDestination('agent')}
                disabled={busy}
              />
              <ListRow
                leading={<GitPullRequest size={18} color={colors.textSecondary} strokeWidth={2} />}
                title={t('components.diffReviewDrawers.gitHubOnPr', 'GitHub, on PR #{{number}}', {
                  number: controller.github?.prNumber ?? 0
                })}
                selected={destination === 'github'}
                accessibilityRole="radio"
                onPress={() => setDestination('github')}
                disabled={busy}
              />
            </ListGroup>
          </View>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  )
}

function quotedLines(
  controller: Props['controller'],
  range: { startLine: number; line: number }
): DiffHunkLine[] {
  const { diffState } = controller
  if (diffState.kind !== 'ready') {
    return []
  }
  return diffState.lines
    .filter(
      (line) =>
        line.kind !== 'delete' &&
        line.newLineNumber !== undefined &&
        line.newLineNumber >= range.startLine &&
        line.newLineNumber <= range.line
    )
    .slice(0, MAX_QUOTED_LINES)
    .map((line, index) => ({
      index,
      number: line.newLineNumber ?? null,
      sign: line.kind === 'add' ? '+' : ' ',
      text: line.text
    }))
}

// The workspace's terminals, listed once per sheet: Send reuses them, and the agent row names the one agent.
function useAgentTerminals(controller: Props['controller']) {
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
      // The row still works without a name; sending lists terminals again and reports its own failure.
      .catch(() => {})
    return () => {
      active = false
    }
  }, [loadTerminals])
  const agents = terminals?.filter((terminal) => terminal.agent !== undefined) ?? []
  const [only] = agents
  const agent = agents.length === 1 && only?.agent ? only.agent : null
  const agentName = agent ? (tuiAgentDisplayName(agent) ?? only?.title ?? null) : null
  return { agent, agentName, terminals }
}
