// Settings' View original, for an agent made from a link: who shared it and when, and the original it was
// made from, read-only while the link still serves it. The desktop's BotSharedFromLine.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { reviewFlagSpots } from '../../../../src/shared/bots/bot-share-review-files'
import { LoadingSpinner } from '../../components/feedback/LoadingSpinner'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { getUiIntlLocale } from '../../i18n/ui-intl-locale'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { isHostNotConnectedError } from '../../query/host-query-errors'
import { SettingsNote } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import type { SettingsFeature, SettingsRootPage } from '../MobileBotSettingsRoot'
import { botShareErrorMessage } from './bot-share-copy'
import { reviewPhoneBotShare, type PhoneShareReview } from './bot-share-receive-operations'
import {
  MobileBotShareReviewOverview,
  reviewListTitle,
  type ReviewPage
} from './MobileBotShareReview'
import { MobileBotShareReviewPage } from './MobileBotShareReviewPages'

type SharedFrom = NonNullable<PhoneBot['sharedFrom']>

export function useBotSharedFromSettings(
  settings: { client: RpcClient | null; routeBot: { bot: PhoneBot }; online: boolean },
  context: {
    banner: ReactNode
    page: SettingsRootPage | null
    setPage: (page: SettingsRootPage | null) => void
  }
): SettingsFeature {
  const t = useMobileTranslation()
  const from = settings.routeBot.bot.sharedFrom
  if (!from) {
    return { rows: [], page: null }
  }
  const by = t('bots.share.original.sharedBy', 'Shared by {{who}}', {
    who: from.sharedBy ?? t('bots.share.review.someone', 'Someone')
  })
  const sharedAt = new Date(from.sharedAt)
  const date = Number.isNaN(sharedAt.getTime())
    ? null
    : new Intl.DateTimeFormat(getUiIntlLocale(), { month: 'short', day: 'numeric' }).format(
        sharedAt
      )
  return {
    rows: [
      {
        key: 'shared-from',
        group: 'identity',
        node: (
          <ListRow
            title={t('bots.share.original.viewOriginal', 'View original')}
            subtitle={date ? `${by} · ${date}` : by}
            subtitleLines={1}
            navigates
            onPress={() => context.setPage('original')}
          />
        )
      }
    ],
    page:
      context.page === 'original' ? (
        <OriginalPage
          client={settings.client}
          online={settings.online}
          from={from}
          banner={context.banner}
          onBack={() => context.setPage(null)}
        />
      ) : null
  }
}

type Read =
  | { kind: 'loading' }
  | { kind: 'read'; review: PhoneShareReview }
  | { kind: 'gone' }
  | { kind: 'failed'; error: string }

function OriginalPage(props: {
  client: RpcClient | null
  /** Off, the page waits for the host under the banner and reads once it answers. */
  online: boolean
  from: SharedFrom
  banner: ReactNode
  onBack: () => void
}) {
  const t = useMobileTranslation()
  const { client, online } = props
  const { shareId, versionId } = props.from
  const [read, setRead] = useState<Read>({ kind: 'loading' })
  const [nav, setNav] = useState<ReviewPage[]>([])
  useEffect(() => {
    if (!client || !online) {
      return
    }
    let live = true
    setRead((current) => (current.kind === 'read' ? current : { kind: 'loading' }))
    reviewPhoneBotShare(client, shareId, versionId).then(
      (review) => live && setRead(review ? { kind: 'read', review } : { kind: 'gone' }),
      (error: unknown) =>
        live &&
        // Lost the host meanwhile: the banner says so, and the read runs again once it answers.
        !isHostNotConnectedError(error) &&
        setRead({ kind: 'failed', error: botShareErrorMessage(error) })
    )
    return () => {
      live = false
    }
  }, [client, online, shareId, versionId])
  useBackClaim(() => {
    if (nav.length > 0) {
      setNav((current) => current.slice(0, -1))
    } else {
      props.onBack()
    }
    return true
  })
  const review = read.kind === 'read' ? read.review : null
  const spots = useMemo(() => (review ? reviewFlagSpots(review) : []), [review])
  const back = { label: t('bots.lookAround.back', 'Back to Settings'), onPress: props.onBack }
  if (!review) {
    return (
      <>
        <SheetHeader title={t('bots.share.receive.sharedBot', 'Shared bot')} onBack={back} />
        {props.banner}
        {!online ? null : read.kind === 'loading' ? (
          <View style={styles.loading}>
            <LoadingSpinner size={20} color={colors.textMuted} />
          </View>
        ) : (
          <SettingsNote>
            {read.kind === 'failed'
              ? read.error
              : t('bots.share.original.originalGone', 'No longer available')}
          </SettingsNote>
        )}
      </>
    )
  }
  const ctx = {
    review,
    spots,
    open: (page: ReviewPage) => setNav((current) => [...current, page]),
    consent: null
  }
  const page = nav.at(-1)
  if (page) {
    const title = (entry: ReviewPage) =>
      entry.kind === 'part' ? entry.title : reviewListTitle(entry.list, t)
    return (
      <>
        <SheetHeader
          title={title(page)}
          subtitle={page.kind === 'part' ? page.detail : undefined}
          onBack={{
            label: nav.length > 1 ? title(nav.at(-2)!) : review.bot.name,
            onPress: () => setNav((current) => current.slice(0, -1))
          }}
        />
        <MobileBotShareReviewPage page={page} ctx={ctx} />
      </>
    )
  }
  return (
    <>
      <SheetHeader title={t('bots.share.receive.sharedBot', 'Shared bot')} onBack={back} />
      {props.banner}
      <MobileBotShareReviewOverview ctx={ctx} choosing={null} />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  loading: { paddingVertical: spacing.xl, alignItems: 'center' }
}))
