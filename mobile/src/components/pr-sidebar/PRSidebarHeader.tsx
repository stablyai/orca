import { useState } from 'react'
import { Text, View } from 'react-native'
import { ArrowRight, ExternalLink, Pencil } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import type { MobilePrTitleAction } from '../../session/use-mobile-pr-title-action'
import { prStateBadge } from './pr-checks-presentation'
import { canEditPRTitle } from '../../session/pr-title-edit'
import { openMobilePrUrl } from '../mobile-pr-url'
import { Badge, type BadgeTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { TextField } from '../ui/TextField'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  pr: PRInfo
  details: GitHubWorkItemDetails | null
  // Inline title-edit action; the pencil affordance only shows when the PR is editable.
  titleAction: MobilePrTitleAction
  // Hub chrome already surfaces open-on-web; hide the duplicate icon in that case.
  showOpenOnWeb?: boolean
  // Kept for callers; identity always renders as a plain block above the actions now.
  bare?: boolean
}

const BADGE_TONE = {
  statusGreen: 'green',
  statusAmber: 'amber',
  statusRed: 'red',
  statusPurple: 'purple',
  textSecondary: 'neutral'
} as const satisfies Record<ReturnType<typeof prStateBadge>['token'], BadgeTone>

// Identity: state + # + author, the title, head → base. The badge is status, not a link.
export function PRSidebarHeader({ pr, details, titleAction, showOpenOnWeb = true }: Props) {
  const item = details?.item
  const badge = prStateBadge(pr.state)
  const title = item?.title ?? pr.title
  const author = item?.author ?? null
  const baseRef = item?.baseRefName ?? null
  const headRef = item?.branchName ?? null
  const editable = canEditPRTitle(pr.state)
  const openPr = pr.url ? () => openMobilePrUrl(pr.url) : undefined

  return (
    <View style={styles.identityBlock}>
      <View style={styles.metaRow}>
        <View style={styles.metaLeft}>
          <Badge label={badge.label} tone={BADGE_TONE[badge.token]} />
          <Text style={styles.prMetaStrong}>#{pr.number}</Text>
          {author ? (
            <Text style={styles.prMeta} numberOfLines={1}>
              · {author}
            </Text>
          ) : null}
        </View>
        {showOpenOnWeb && openPr ? (
          <IconButton
            icon={ExternalLink}
            iconSize={18}
            onPress={openPr}
            accessibilityLabel={`Open pull request #${pr.number} in browser`}
          />
        ) : null}
      </View>
      <PRTitle title={title} editable={editable} titleAction={titleAction} />
      {baseRef && headRef ? (
        <View
          style={styles.branchRow}
          accessible
          accessibilityLabel={`Merges ${headRef} into ${baseRef}`}
        >
          <Text style={styles.branchPill} numberOfLines={1}>
            {headRef}
          </Text>
          <ArrowRight size={14} color={colors.textMuted} strokeWidth={2.2} />
          <Text style={styles.branchPill} numberOfLines={1}>
            {baseRef}
          </Text>
        </View>
      ) : null}
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
      <View style={styles.titleEdit}>
        <TextField
          value={draft}
          onChangeText={setDraft}
          accessibilityLabel="Pull request title"
          placeholder="Pull request title"
          editable={!titleAction.saving}
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          footnote={titleAction.error ?? undefined}
          error={titleAction.error !== null}
          autoFocus
        />
        <View style={styles.titleEditActions}>
          <Button
            label="Cancel"
            variant="plain"
            size="compact"
            onPress={cancel}
            disabled={titleAction.saving}
            accessibilityLabel="Cancel editing title"
          />
          <Button
            label="Save"
            size="compact"
            onPress={() => void save()}
            busy={titleAction.saving}
            accessibilityLabel="Save title"
          />
        </View>
      </View>
    )
  }

  return (
    <View style={styles.titleRow}>
      <Text style={styles.prTitle} accessibilityRole="header">
        {title}
      </Text>
      {editable ? (
        <IconButton
          icon={Pencil}
          variant="bare"
          iconSize={17}
          iconColor={colors.textSecondary}
          onPress={startEdit}
          accessibilityLabel="Edit pull request title"
        />
      ) : null}
    </View>
  )
}
