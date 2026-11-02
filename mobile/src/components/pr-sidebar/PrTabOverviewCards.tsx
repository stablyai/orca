import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { colors, pressedStyle } from '../../theme/mobile-theme'
import type { PrSidebarData } from '../../session/mobile-pr-sidebar-state'
import { isPrSidebarDetailsPlaceholder } from '../../session/mobile-pr-sidebar-state'
import { canEditPRTitle } from '../../session/pr-title-edit'
import { AutoHeight } from '../AutoHeight'
import { CommentMarkdown } from './CommentMarkdown'
import type { MobilePrTab } from './use-mobile-pr-tab'
import { prTabStyles as styles } from './pr-tab-styles'

// The PR tab's changes card and its collapsed description.
export function PrChangesCard({ data, onPress }: { data: PrSidebarData; onPress?: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const details = data.details && !isPrSidebarDetailsPlaceholder(data.details) ? data.details : null
  // Older hosts send no file list; a zero card would claim the PR is empty.
  const files = details?.files
  if (!files || files.length === 0) {
    return null
  }
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const viewed = files.filter((file) => file.viewerViewedState === 'VIEWED').length
  const inlineComments = details.comments.filter((comment) => comment.path)
  const commentedFiles = new Set(inlineComments.map((comment) => comment.path)).size
  const meta = [
    t('pullRequest.tab.viewedOf', '{{viewed}} of {{total}} viewed', {
      viewed,
      total: files.length
    }),
    inlineComments.length > 0
      ? t('pullRequest.tab.commentsOnFiles', '{{comments}} comments on {{files}} files', {
          comments: inlineComments.length,
          files: commentedFiles
        })
      : null
  ]
    .filter(Boolean)
    .join(' · ')
  const title =
    files.length === 1
      ? t('pullRequest.tab.filesChanged_one', '{{count}} file changed', { count: files.length })
      : t('pullRequest.tab.filesChanged_other', '{{count}} files changed', {
          count: files.length
        })
  const content = (
    <>
      <View style={styles.changesTop}>
        <Text style={styles.changesTitle}>{title}</Text>
        <Text style={styles.additions}>+{additions}</Text>
        <Text style={styles.deletions}>−{deletions}</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${(viewed / files.length) * 100}%` }]} />
      </View>
      <Text style={styles.changesMeta}>{meta}</Text>
    </>
  )
  if (!onPress) {
    return <View style={styles.changesCard}>{content}</View>
  }
  return (
    <Pressable
      style={({ pressed }) => [styles.changesCard, pressed && pressedStyle]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${meta}`}
    >
      {content}
    </Pressable>
  )
}

const COLLAPSED_DESCRIPTION_HEIGHT = 84

export function PrDescription({ tab, data }: { tab: MobilePrTab; data: PrSidebarData }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const details = data.details
  const failed = details != null && isPrSidebarDetailsPlaceholder(details)
  const body = details && !failed ? details.body : ''
  const editable = canEditPRTitle(data.pr.state) && details !== null && !failed
  return (
    <View>
      <View style={styles.descriptionHeader}>
        <Text style={styles.sectionLabel}>
          {t('pullRequest.commentsSection.description', 'Description')}
        </Text>
        {editable ? (
          <Pressable
            onPress={tab.openEditDescriptionSheet}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('pullRequest.tab.editDescription', 'Edit description')}
            style={({ pressed }) => pressed && pressedStyle}
          >
            <Text style={styles.textAction}>{t('pullRequest.tab.edit', 'Edit')}</Text>
          </Pressable>
        ) : null}
      </View>
      {details === null ? (
        <ActivityIndicator color={colors.textSecondary} />
      ) : failed ? (
        <Text style={styles.descriptionMuted}>
          {t(
            'pullRequest.commentsSection.descriptionLoadFailed',
            'Could not load description. Tap refresh to try again.'
          )}
        </Text>
      ) : body.trim() ? (
        <>
          <AutoHeight maxHeight={expanded ? undefined : COLLAPSED_DESCRIPTION_HEIGHT}>
            <View
              onLayout={(event) =>
                setOverflows(event.nativeEvent.layout.height > COLLAPSED_DESCRIPTION_HEIGHT)
              }
            >
              <CommentMarkdown content={body} variant="document" />
            </View>
          </AutoHeight>
          {overflows ? (
            <Pressable
              onPress={() => setExpanded((value) => !value)}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text style={styles.showMore}>
                {expanded
                  ? t('pullRequest.tab.showLess', 'Show less')
                  : t('pullRequest.tab.showMore', 'Show more')}
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : (
        <Text style={styles.descriptionMuted}>
          {t('pullRequest.commentsSection.noDescription', 'No description provided.')}
        </Text>
      )}
    </View>
  )
}
