// New bot › From a link on the phone: paste a link, read its review, then make your copy. Nothing is
// created until Create. The desktop's BotShareReceiveFlow, review and New bot from a link.
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import type { BotAgent } from '../../../../src/shared/bot-types'
import { reviewFlagSpots } from '../../../../src/shared/bots/bot-share-review-files'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { useBottomDrawerModalHostBackClaim } from '../../components/bottom-drawer/bottom-drawer-modal-host-scope'
import { LoadingSpinner } from '../../components/feedback/LoadingSpinner'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsNote } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ListedBot, PhoneBot } from '../host-bots-operations'
import { mobileBotAvatarSource } from '../host-bot-row-facts'
import { MobileBotAvatar } from '../MobileBotAvatar'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { botShareDate, botShareErrorMessage } from './bot-share-copy'
import { MobileBotSharePasteLink } from './MobileBotSharePasteLink'
import {
  EMPTY_SHARE_CREATE_DRAFT,
  MobileBotShareCreate,
  type ShareCreateDraft
} from './MobileBotShareCreate'
import { reviewPhoneBotShare, type PhoneShareReview } from './bot-share-receive-operations'
import {
  MobileBotShareReviewOverview,
  reviewListTitle,
  type ReviewPage
} from './MobileBotShareReview'
import { MobileBotShareReviewPage } from './MobileBotShareReviewPages'
import { keptToolTicks } from './bot-share-tool-ticks'

type Step =
  | { kind: 'paste' }
  | { kind: 'loading'; shareId: string; again: boolean }
  | { kind: 'have'; shareId: string; bot: ListedBot }
  | { kind: 'stopped' }
  | { kind: 'review'; review: PhoneShareReview; updated: boolean }
  | { kind: 'create'; review: PhoneShareReview }

export function MobileBotShareReceiveSheet(props: {
  visible: boolean
  /** The route to the chosen computer, where the review is read and the bot is made. */
  client: RpcClient | null
  /** The bots on that computer: a link one was made from offers it first, and names stay free. */
  bots: readonly ListedBot[]
  agent: BotAgent
  /** Runs on and Agent, as New bot's rows, and the note under them. */
  pickerRows: readonly ReactElement[]
  pickerNote: ReactNode
  /** The computer is reachable and has said which agents it has. */
  ready: boolean
  onBack: () => void
  onClose: () => void
  onAfterClose?: () => void
  onCreated: (bot: PhoneBot) => void
  onOpenBot: (bot: ListedBot) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { client } = props
  const [step, setStep] = useState<Step>({ kind: 'paste' })
  const [nav, setNav] = useState<ReviewPage[]>([])
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const [toolIds, setToolIds] = useState<string[]>([])
  // The review the ticks were made on.
  const shownReview = useRef<PhoneShareReview | null>(null)
  const [draft, setDraft] = useState<ShareCreateDraft>(EMPTY_SHARE_CREATE_DRAFT)
  const [link, setLink] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Read when a link loads, so a new list of bots doesn't send the review again.
  const botsRef = useRef(props.bots)
  useEffect(() => {
    botsRef.current = props.bots
  })

  useEffect(() => {
    if (step.kind !== 'loading' || !client) {
      return
    }
    const made = step.again
      ? null
      : botsRef.current.find((bot) => bot.sharedFrom?.shareId === step.shareId)
    if (made) {
      setStep({ kind: 'have', shareId: step.shareId, bot: made })
      return
    }
    let current = true
    reviewPhoneBotShare(client, step.shareId).then(
      (review) => {
        if (current) {
          // A new link starts clean; the same link read again keeps what the owner chose, but a
          // tool tick only while that tool's address is unchanged.
          const shown = shownReview.current
          shownReview.current = review
          setToolIds((ticked) => (step.again && review ? keptToolTicks(shown, review, ticked) : []))
          if (!step.again) {
            setDraft(EMPTY_SHARE_CREATE_DRAFT)
          }
          setNav([])
          setStep(review ? { kind: 'review', review, updated: false } : { kind: 'stopped' })
        }
      },
      (cause: unknown) => {
        if (current) {
          setError(botShareErrorMessage(cause))
          setStep({ kind: 'paste' })
        }
      }
    )
    return () => {
      current = false
    }
  }, [client, step])

  // The review is read on the computer that makes the bot: Runs on moving reads the link there.
  const lastClient = useRef(client)
  useEffect(() => {
    if (lastClient.current === client) {
      return
    }
    lastClient.current = client
    setStep((current) =>
      current.kind === 'review' || current.kind === 'create'
        ? { kind: 'loading', shareId: current.review.shareId, again: true }
        : current
    )
  }, [client])

  // Back walks up: a page, then the review, then the paste field, then New bot.
  const back = permissionsOpen
    ? () => setPermissionsOpen(false)
    : nav.length > 0
      ? () => setNav((current) => current.slice(0, -1))
      : step.kind === 'create'
        ? () => setStep({ kind: 'review', review: step.review, updated: false })
        : step.kind === 'paste'
          ? null
          : () => setStep({ kind: 'paste' })
  // Only while shown: a picker over it holds Back, and it claims again when it comes back.
  const claim = props.visible ? back : null
  useBottomDrawerModalHostBackClaim(claim)
  useBackClaim(
    claim
      ? () => {
          claim()
          return true
        }
      : null
  )
  const reviewAgain = (shareId: string) => setStep({ kind: 'loading', shareId, again: true })

  let body: ReactNode
  switch (step.kind) {
    case 'paste':
      body = (
        <MobileBotSharePasteLink
          reachable={client !== null}
          value={link}
          setValue={setLink}
          error={error}
          onBack={props.onBack}
          onLink={(shareId) => {
            setError(null)
            setStep({ kind: 'loading', shareId, again: false })
          }}
        />
      )
      break
    case 'loading':
      body = (
        <>
          <SheetHeader
            title={t('bots.share.receive.fromLink', 'From a link')}
            onBack={{
              label: t('bots.share.receive.back', 'Back'),
              onPress: () => setStep({ kind: 'paste' })
            }}
          />
          <View style={styles.loading}>
            <LoadingSpinner size={20} color={colors.textMuted} />
          </View>
        </>
      )
      break
    case 'have':
      body = (
        <>
          <SheetHeader
            title={t('bots.share.receive.have', 'You already have this bot')}
            onBack={{
              label: t('bots.share.receive.back', 'Back'),
              onPress: () => setStep({ kind: 'paste' })
            }}
          />
          <View style={styles.hero}>
            <MobileBotAvatar avatar={mobileBotAvatarSource(step.bot)} size={56} />
            <Text style={styles.detail}>
              {t('bots.share.receive.haveDetail', '{{name}} · made {{date}}', {
                name: step.bot.name,
                date: step.bot.createdAt
                  ? botShareDate(new Date(step.bot.createdAt).toISOString())
                  : ''
              })}
            </Text>
          </View>
          <View style={styles.foot}>
            <SheetPrimaryButton
              label={t('bots.share.receive.open', 'Open')}
              onPress={() => props.onOpenBot(step.bot)}
            />
            <MobileBotTextButton
              label={t('bots.share.review.reviewAgain', 'Review again')}
              onPress={() => reviewAgain(step.shareId)}
            />
          </View>
        </>
      )
      break
    case 'stopped':
      body = (
        <>
          <SheetHeader
            title={t('bots.share.receive.stopped', 'This link no longer works')}
            onBack={{
              label: t('bots.share.receive.back', 'Back'),
              onPress: () => setStep({ kind: 'paste' })
            }}
          />
          <SettingsNote>
            {t('bots.share.receive.stoppedDetail', 'Ask whoever shared it for a new one.')}
          </SettingsNote>
        </>
      )
      break
    case 'review':
    case 'create':
      body = (
        <ReviewSteps
          step={step}
          nav={nav}
          setNav={setNav}
          toolIds={toolIds}
          setToolIds={setToolIds}
          draft={draft}
          setDraft={setDraft}
          permissionsOpen={permissionsOpen}
          setPermissionsOpen={setPermissionsOpen}
          client={client}
          bots={props.bots}
          agent={props.agent}
          pickerRows={props.pickerRows}
          pickerNote={props.pickerNote}
          ready={props.ready}
          onStep={setStep}
          onReviewAgain={reviewAgain}
          onCreated={props.onCreated}
        />
      )
      break
  }
  return (
    <BottomDrawer
      visible={props.visible}
      onClose={props.onClose}
      onAfterClose={props.onAfterClose}
      scrollResetKey={`${step.kind}:${nav.length}:${permissionsOpen}`}
    >
      {body}
    </BottomDrawer>
  )
}

function ReviewSteps(props: {
  step: Extract<Step, { kind: 'review' | 'create' }>
  nav: ReviewPage[]
  setNav: (update: (current: ReviewPage[]) => ReviewPage[]) => void
  toolIds: string[]
  setToolIds: (ids: string[]) => void
  draft: ShareCreateDraft
  setDraft: (update: (draft: ShareCreateDraft) => ShareCreateDraft) => void
  permissionsOpen: boolean
  setPermissionsOpen: (open: boolean) => void
  client: RpcClient | null
  bots: readonly ListedBot[]
  agent: BotAgent
  pickerRows: readonly ReactElement[]
  pickerNote: ReactNode
  ready: boolean
  onStep: (step: Step) => void
  onReviewAgain: (shareId: string) => void
  onCreated: (bot: PhoneBot) => void
}) {
  const t = useMobileTranslation()
  const { step, nav } = props
  const { review } = step
  const spots = useMemo(() => reviewFlagSpots(review), [review])
  const ctx = {
    review,
    spots,
    open: (page: ReviewPage) => props.setNav((current) => [...current, page]),
    consent: { toolIds: props.toolIds, setToolIds: props.setToolIds }
  }
  if (step.kind === 'create') {
    return (
      <MobileBotShareCreate
        review={review}
        toolIds={props.toolIds}
        setToolIds={props.setToolIds}
        draft={props.draft}
        setDraft={props.setDraft}
        permissionsOpen={props.permissionsOpen}
        setPermissionsOpen={props.setPermissionsOpen}
        client={props.client}
        bots={props.bots}
        agent={props.agent}
        pickerRows={props.pickerRows}
        pickerNote={props.pickerNote}
        ready={props.ready}
        onBack={() => props.onStep({ kind: 'review', review, updated: false })}
        onMoved={(why) =>
          props.onStep(
            why === 'stopped'
              ? { kind: 'stopped' }
              : why === 'expired'
                ? { kind: 'loading', shareId: review.shareId, again: true }
                : { kind: 'review', review, updated: true }
          )
        }
        onCreated={props.onCreated}
      />
    )
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
            onPress: () => props.setNav((current) => current.slice(0, -1))
          }}
        />
        <MobileBotShareReviewPage page={page} ctx={ctx} />
      </>
    )
  }
  return (
    <>
      <SheetHeader
        title={t('bots.share.receive.sharedBot', 'Shared bot')}
        onBack={{
          label: t('bots.share.receive.fromLink', 'From a link'),
          onPress: () => props.onStep({ kind: 'paste' })
        }}
      />
      <MobileBotShareReviewOverview
        ctx={ctx}
        choosing={{
          updated: step.updated,
          onCreate: () => props.onStep({ kind: 'create', review }),
          onReviewAgain: () => props.onReviewAgain(review.shareId)
        }}
      />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  loading: { paddingVertical: spacing.xl, alignItems: 'center' },
  hero: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  detail: { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
  foot: {
    gap: spacing.sm,
    alignItems: 'stretch',
    paddingTop: spacing.md,
    paddingBottom: spacing.md
  }
}))
