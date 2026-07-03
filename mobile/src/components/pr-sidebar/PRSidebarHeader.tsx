import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { ArrowRight, Pencil } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { GitHubWorkItemDetails, PRInfo } from '../../../../src/shared/types'
import type { MobilePrTitleAction } from '../../session/use-mobile-pr-title-action'
import { prStateBadge } from './pr-checks-presentation'
import { statusColor } from './pr-sidebar-status-color'
import { canEditPRTitle } from '../../session/pr-title-edit'
import { openMobilePrUrl } from '../MobilePrComposeSheet'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'
import { prCommentComposerStyles as composerStyles } from './pr-comment-composer-styles'

type Props = {
  pr: PRInfo
  details: GitHubWorkItemDetails | null
  // Inline title-edit action; the pencil affordance only shows when the PR is editable.
  titleAction: MobilePrTitleAction
}

// Header: state badge (incl. draft — display-only), title, author, head->base.
// The title is inline-editable on an open/draft PR (desktop parity).
export function PRSidebarHeader({ pr, details, titleAction }: Props) {
  const item = details?.item
  const badge = prStateBadge(pr.state)
  const badgeColor = statusColor(badge.token)
  const title = item?.title ?? pr.title
  const author = item?.author ?? null
  const baseRef = item?.baseRefName ?? null
  const headRef = item?.branchName ?? null
  const editable = canEditPRTitle(pr.state)
  // Tapping the state badge or the #number opens the PR on its host (GitHub/etc.)
  // in the phone browser — pr.url is the canonical web URL.
  const openPr = pr.url ? () => openMobilePrUrl(pr.url) : undefined

  return (
    <View style={styles.section}>
      <View style={styles.sectionBody}>
        <Pressable
          onPress={openPr}
          disabled={!openPr}
          accessibilityRole="link"
          accessibilityLabel={`Open pull request #${pr.number} on the web`}
          style={({ pressed }) => [
            styles.badge,
            { borderColor: badgeColor },
            pressed && { opacity: 0.6 }
          ]}
        >
          <Text style={[styles.badgeText, { color: badgeColor }]}>{badge.label}</Text>
        </Pressable>
        <PRTitle
          title={title}
          number={pr.number}
          editable={editable}
          openPr={openPr}
          titleAction={titleAction}
        />
        {author ? <Text style={styles.prMeta}>by {author}</Text> : null}
        {baseRef && headRef ? (
          // head -> base reads in merge direction (desktop ChecksPanel parity).
          <View style={styles.branchRow}>
            <Text style={styles.branchPill}>{headRef}</Text>
            <ArrowRight size={12} color={colors.textSecondary} strokeWidth={2.2} />
            <Text style={styles.branchPill}>{baseRef}</Text>
          </View>
        ) : null}
      </View>
    </View>
  )
}

function PRTitle({
  title,
  number,
  editable,
  openPr,
  titleAction
}: {
  title: string
  number: number
  editable: boolean
  openPr: (() => void) | undefined
  titleAction: MobilePrTitleAction
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)

  const startEdit = () => {
    titleAction.clearError()
    setDraft(title)
    setEditing(true)
  }
  const cancel = () => {
    titleAction.clearError()
    setEditing(false)
  }
  const save = async () => {
    // setTitle trims + short-circuits empty/unchanged to a successful no-op; on a
    // real edit it refetches, so on success we just collapse the editor.
    const ok = await titleAction.setTitle(draft, title)
    if (ok) {
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <View>
        <TextInput
          style={composerStyles.input}
          value={draft}
          onChangeText={setDraft}
          placeholderTextColor={colors.textMuted}
          editable={!titleAction.saving}
          autoFocus
        />
        {titleAction.error ? <Text style={composerStyles.error}>{titleAction.error}</Text> : null}
        <View style={composerStyles.actions}>
          <Pressable
            style={({ pressed }) => [composerStyles.cancel, pressed && composerStyles.pressed]}
            onPress={cancel}
            disabled={titleAction.saving}
            accessibilityRole="button"
            accessibilityLabel="Cancel editing title"
          >
            <Text style={composerStyles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [composerStyles.submit, pressed && composerStyles.pressed]}
            onPress={() => void save()}
            disabled={titleAction.saving}
            accessibilityRole="button"
            accessibilityLabel="Save title"
          >
            {titleAction.saving ? (
              <ActivityIndicator size="small" color={colors.bgBase} />
            ) : (
              <Text style={composerStyles.submitText}>Save</Text>
            )}
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <Pressable
      style={styles.titleRow}
      onPress={editable ? startEdit : undefined}
      disabled={!editable}
      accessibilityRole={editable ? 'button' : undefined}
      accessibilityLabel={editable ? 'Edit pull request title' : undefined}
    >
      <Text style={styles.prTitle}>
        {title}{' '}
        <Text
          style={styles.prMeta}
          onPress={openPr}
          accessibilityRole="link"
          accessibilityLabel={`Open pull request #${number} on the web`}
        >
          #{number}
        </Text>
      </Text>
      {editable ? (
        <View style={styles.titleEditButton}>
          <Pencil size={14} color={colors.textSecondary} strokeWidth={2} />
        </View>
      ) : null}
    </Pressable>
  )
}
