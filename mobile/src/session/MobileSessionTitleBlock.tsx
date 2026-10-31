import { Fragment } from 'react'
import { DetailCardFocusBoundary } from '../components/detail-card-host'
import { Platform, Pressable, StyleSheet, Text } from 'react-native'
import type { SessionTitleCard } from './use-session-title-card'
import { StatusDot } from '../components/StatusDot'
import type { ConnectionState } from '../transport/types'
import { styles } from './mobile-session-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

/** The session's title and status line. A tap opens a card with the full name, where it lives
 *  and its host, as desktop's tab card does, because a sideways phone cuts the title short. */
export function MobileSessionTitleBlock({
  title,
  connState,
  details,
  meta,
  centered = false,
  showConnectionRetry,
  onRetry
}: {
  title: string
  connState: ConnectionState
  details: SessionTitleCard
  meta: string
  /** Sits in NavBar's centre slot rather than beside the tabs. */
  centered?: boolean
  showConnectionRetry: boolean
  onRetry: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  return (
    <>
      <DetailCardFocusBoundary refs={details.boundaryRefs} index={0} active={details.titleActive} />
      <Fragment key="title">
        <Pressable
          style={
            centered
              ? centeredStyles.block
              : [styles.sessionTitleBlock, details.besideTabs && styles.sessionTitleBlockBesideTabs]
          }
          ref={details.openerRef}
          onLayout={details.onAnchorLayout}
          onPress={details.toggle}
          aria-expanded={details.titleRequestedOpen}
          accessibilityRole="button"
          accessibilityHint={t(
            'session.header.workspaceDetailsHint',
            'Shows the full workspace name and where it is'
          )}
        >
          <Text
            ref={details.titleRef}
            onLayout={details.onAnchorLayout}
            onPress={Platform.OS === 'web' ? details.toggle : undefined}
            style={[styles.sessionTitle, centered && centeredStyles.title]}
            numberOfLines={1}
          >
            {title}
          </Text>
          <Pressable
            style={styles.sessionMetaRow}
            disabled={!showConnectionRetry}
            onPress={onRetry}
            accessibilityRole={showConnectionRetry ? 'button' : undefined}
            accessibilityLabel={
              showConnectionRetry
                ? t('session.header.reconnectToDesktop', 'Reconnect to desktop')
                : undefined
            }
          >
            <StatusDot state={connState} />
            <Text style={styles.sessionMetaText} numberOfLines={1}>
              {meta}
            </Text>
          </Pressable>
        </Pressable>
      </Fragment>
      <DetailCardFocusBoundary refs={details.boundaryRefs} index={1} active={details.titleActive} />
    </>
  )
}

const centeredStyles = StyleSheet.create({
  block: {
    maxWidth: '100%',
    alignItems: 'center'
  },
  // NavBar's title size, so the session bar reads like every other screen's.
  title: {
    fontSize: 16
  }
})
