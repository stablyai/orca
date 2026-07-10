import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { ArrowRight, ExternalLink, Pencil } from 'lucide-react-native'
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
  // Hub chrome already surfaces open-on-web; hide the duplicate icon in that case.
  showOpenOnWeb?: boolean
  // When true, render without section chrome so identity can share a card with actions.
  bare?: boolean
}

// Compact identity: state + # + author on one meta row, title, head→base.
// # lives only in the meta row (not also after the title) to avoid repetition.
export function PRSidebarHeader({
  pr,
  details,
  titleAction,
  showOpenOnWeb = true,
  bare = false
}: Props) {
  const item = details?.item
  const badge = prStateBadge(pr.state)
  const badgeColor = statusColor(badge.token)
  const title = item?.title ?? pr.title
  const author = item?.author ?? null
  const baseRef = item?.baseRefName ?? null
  const headRef = item?.branchName ?? null
  const editable = canEditPRTitle(pr.state)
  const openPr = pr.url ? () => openMobilePrUrl(pr.url) : undefined

  const body = (
    <>
      <View style={styles.metaRow}>
        <View style={styles.metaLeft}>
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
          <Text
            style={styles.prMetaStrong}
            onPress={openPr}
            accessibilityRole="link"
            accessibilityLabel={`Open pull request #${pr.number} on the web`}
          >
            #{pr.number}
          </Text>
          {author ? <Text style={styles.prMeta}>· {author}</Text> : null}
        </View>
        {showOpenOnWeb && openPr ? (
          <Pressable
            onPress={openPr}
            hitSlop={8}
            accessibilityRole="link"
            accessibilityLabel={`Open pull request #${pr.number} in browser`}
            style={({ pressed }) => [styles.iconButton, pressed && { opacity: 0.6 }]}
          >
            <ExternalLink size={16} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
        ) : null}
      </View>
      <PRTitle title={title} editable={editable} titleAction={titleAction} />
      {baseRef && headRef ? (
        <View style={styles.branchRow}>
          <Text style={styles.branchPill} numberOfLines={1}>
            {headRef}
          </Text>
          <ArrowRight size={12} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.branchPill} numberOfLines={1}>
            {baseRef}
          </Text>
        </View>
      ) : null}
    </>
  )

  if (bare) {
    return <View style={styles.identityBlock}>{body}</View>
  }
  return (
    <View style={styles.section}>
      <View style={styles.sectionBody}>{body}</View>
    </View>
  )
}

function PRTitle({
  title,
  editable,
  titleAction
}: {
  title: string
  editable: boolean
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
      <View style={composerStyles.container}>
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
      <Text style={styles.prTitle}>{title}</Text>
      {editable ? (
        <View style={styles.titleEditButton}>
          <Pencil size={14} color={colors.textSecondary} strokeWidth={2} />
        </View>
      ) : null}
    </Pressable>
  )
}
