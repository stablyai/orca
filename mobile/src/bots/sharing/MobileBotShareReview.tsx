// A received link's review on the phone: who shared it, the safety check, and one row per part, each
// drilling in to the exact text Create writes. The desktop's BotShareReviewDialog and its pages.
import { Text, View } from 'react-native'
import { ShieldAlert, TriangleAlert } from 'lucide-react-native'
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import type { BotShareFlagSpot } from '../../../../src/shared/bots/bot-share-flag-spots'
import { toolHost } from '../../../../src/shared/bots/bot-share-review-files'
import { textLineCount } from '../../../../src/shared/bots/bot-text-scan'
import { ListRow } from '../../components/list/ListGroup'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { getUiIntlLocale } from '../../i18n/ui-intl-locale'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileBotAvatar } from '../MobileBotAvatar'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { botShareCheckSummary, botShareFlagLabel } from './bot-share-copy'
import type { PhoneShareReview } from './bot-share-receive-operations'
import { reviewAvatar } from './bot-share-review-avatar'
import { ShareTickRow } from './MobileBotShareParts'
import { shareFlagPage, type SharePartPage } from './mobile-share-pages'

export type ReviewList =
  | 'skills'
  | 'automations'
  | 'tools'
  | 'accounts'
  | 'memory'
  | 'check'
  | 'leftOut'

export type ReviewPage = { kind: 'list'; list: ReviewList } | SharePartPage

export type ReviewContext = {
  review: PhoneShareReview
  spots: BotShareFlagSpot[]
  open: (page: ReviewPage) => void
  toolIds: string[]
  setToolIds: (ids: string[]) => void
}

export function reviewListTitle(list: ReviewList, t: ReturnType<typeof useMobileTranslation>) {
  const titles: Record<ReviewList, string> = {
    skills: t('bots.share.skills', 'Skills'),
    automations: t('bots.share.automations', 'Automations'),
    tools: t('bots.share.tools', 'Tools'),
    accounts: t('bots.share.review.accounts', 'Accounts to connect'),
    memory: t('bots.share.memory', 'Memory'),
    check: t('bots.share.safetyCheck', 'Safety check'),
    leftOut: t('bots.share.review.leftOut', 'Left out')
  }
  return titles[list]
}

/** The review page that shows a flag; a setup-note flag shows in Accounts to connect. */
export function reviewFlagPage(
  spot: BotShareFlagSpot,
  t: ReturnType<typeof useMobileTranslation>
): ReviewPage | null {
  if (spot.flag.where === 'bot.json#setupNote') {
    return { kind: 'list', list: 'accounts' }
  }
  const page = shareFlagPage(spot, t)
  // A skill's page is the skill, as its row in Skills opens it.
  return page?.part.startsWith('skill:')
    ? { ...page, title: page.part.slice('skill:'.length), showNames: true }
    : page
}

const CONNECTOR_NAMES: Readonly<Record<string, string>> = BOT_CONNECTOR_NAMES

export function reviewAccounts(review: PhoneShareReview): string[] {
  return review.bot.connectors.map(({ kind }) => CONNECTOR_NAMES[kind] ?? kind)
}

export const flagOf = (
  spots: readonly BotShareFlagSpot[],
  prefix: string
): 'secret' | 'warning' | null =>
  spots.some((spot) => spot.part?.startsWith(prefix))
    ? spots.some((spot) => spot.part?.startsWith(prefix) && spot.flag.kind === 'secret')
      ? 'secret'
      : 'warning'
    : null

export function FlagMark({ flag }: { flag: 'secret' | 'warning' | null }) {
  useMobileColorScheme()
  if (!flag) {
    return null
  }
  const Icon = flag === 'secret' ? ShieldAlert : TriangleAlert
  return <Icon size={15} color={flag === 'secret' ? colors.statusRed : colors.statusAmber} />
}

/** The review's first view: hero, safety line, one row per part, then Create bot…. */
export function MobileBotShareReviewOverview(props: {
  ctx: ReviewContext
  /** The sharer moved the link since this review: Create would write a version not shown. */
  updated: boolean
  onCreate: () => void
  onReviewAgain: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { ctx } = props
  const { review, spots } = ctx
  const { bot } = review
  const list = (name: ReviewList) => () => ctx.open({ kind: 'list', list: name })
  const soul = review.files.find((file) => file.path === 'SOUL.md')
  const soulLines = t('bots.share.lines', '{{count}} lines', {
    count: soul?.text ? textLineCount(soul.text) : 0
  })
  const automations = bot.schedules.length + bot.eventSuggestions.length
  const accounts = reviewAccounts(review)
  const none = t('bots.share.review.none', 'None')
  const count = (value: number) => (value > 0 ? String(value) : none)
  const [first] = spots
  const secret = spots.some((spot) => spot.flag.kind === 'secret')
  const date = new Intl.DateTimeFormat(getUiIntlLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(review.publishedAt))
  const row = (
    title: string,
    value: string,
    flag: 'secret' | 'warning' | null,
    onOpen: (() => void) | undefined
  ) => (
    <ListRow
      title={title}
      value={value}
      accessory={<FlagMark flag={flag} />}
      navigates={onOpen !== undefined}
      onPress={onOpen}
    />
  )
  return (
    <>
      <View style={styles.hero}>
        <MobileBotAvatar avatar={reviewAvatar(review)} size={64} />
        <Text style={styles.name} numberOfLines={2}>
          {bot.name}
        </Text>
        {bot.purpose ? (
          <Text style={styles.purpose} numberOfLines={3}>
            {bot.purpose}
          </Text>
        ) : null}
        <Text style={styles.byline}>
          {t('bots.share.review.byline', '{{who}} · {{date}} · Not reviewed', {
            who: review.publisher ?? t('bots.share.review.someone', 'Someone'),
            date
          })}
        </Text>
      </View>
      {first ? (
        <SettingsSection>
          <ListRow
            leading={
              <TriangleAlert size={18} color={secret ? colors.statusRed : colors.statusAmber} />
            }
            wrapTitle
            title={
              spots.length === 1
                ? t('bots.share.review.oneFlag', '{{summary}}: {{flag}} in {{where}}', {
                    summary: botShareCheckSummary(spots),
                    flag: botShareFlagLabel(first.flag.kind).toLowerCase(),
                    where: first.part?.startsWith('skill:')
                      ? first.part.slice('skill:'.length)
                      : first.where
                  })
                : botShareCheckSummary(spots)
            }
            accessory={
              <MobileBotTextButton
                label={t('bots.share.view', 'View')}
                onPress={() =>
                  ctx.open(
                    (spots.length === 1 ? reviewFlagPage(first, t) : null) ?? {
                      kind: 'list',
                      list: 'check'
                    }
                  )
                }
              />
            }
          />
        </SettingsSection>
      ) : null}
      <SettingsSection>
        {row(t('bots.share.soul', 'Soul'), soulLines, flagOf(spots, 'soul'), () =>
          ctx.open({
            kind: 'part',
            part: 'soul',
            title: t('bots.share.soul', 'Soul'),
            detail: `SOUL.md · ${soulLines}`
          })
        )}
        {row(
          t('bots.share.skills', 'Skills'),
          count(bot.skills.length),
          flagOf(spots, 'skill:'),
          bot.skills.length > 0 ? list('skills') : undefined
        )}
        {row(
          t('bots.share.automations', 'Automations'),
          count(automations),
          flagOf(spots, 'schedule:') ?? flagOf(spots, 'event:'),
          automations > 0 ? list('automations') : undefined
        )}
        {row(
          t('bots.share.tools', 'Tools'),
          count(bot.tools.length),
          null,
          bot.tools.length > 0 ? list('tools') : undefined
        )}
        {row(
          t('bots.share.review.accounts', 'Accounts to connect'),
          accounts.length > 0 ? accounts.join(', ') : none,
          flagOf(spots, 'note'),
          accounts.length > 0 || bot.setupNote ? list('accounts') : undefined
        )}
        {row(
          t('bots.share.memory', 'Memory'),
          bot.memory.length === 0
            ? none
            : bot.memory.length === 1
              ? t('bots.share.review.oneNote', '1 note')
              : t('bots.share.review.notes', '{{count}} notes', { count: bot.memory.length }),
          flagOf(spots, 'memory:'),
          bot.memory.length > 0 ? list('memory') : undefined
        )}
        {review.leftOut.length > 0
          ? row(
              t('bots.share.review.leftOut', 'Left out'),
              String(review.leftOut.length),
              null,
              list('leftOut')
            )
          : null}
      </SettingsSection>
      <View style={styles.foot}>
        {props.updated ? (
          <Text style={styles.hint}>
            {t('bots.share.review.updated', '{{who}} updated this bot. Review it again.', {
              who: review.publisher ?? t('bots.share.review.theSharer', 'The sharer')
            })}
          </Text>
        ) : null}
        {props.updated ? (
          <SheetPrimaryButton
            label={t('bots.share.review.reviewAgain', 'Review again')}
            onPress={props.onReviewAgain}
          />
        ) : (
          <SheetPrimaryButton
            label={t('bots.share.review.createBot', 'Create bot…')}
            onPress={props.onCreate}
          />
        )}
      </View>
    </>
  )
}

/** The tools the owner lets a bot from the link contact; unticked until they say so. */
export function ReviewToolTicks(props: {
  review: PhoneShareReview
  toolIds: string[]
  setToolIds: (ids: string[]) => void
  first?: boolean
}) {
  const t = useMobileTranslation()
  return (
    <SettingsSection first={props.first}>
      {props.review.bot.tools.map((tool) => {
        const on = props.toolIds.includes(tool.id)
        return (
          <ShareTickRow
            key={tool.id}
            title={t('bots.share.review.contact', 'Let it contact {{host}}', {
              host: toolHost(tool.url)
            })}
            subtitle={tool.name}
            on={on}
            onToggle={(next) =>
              props.setToolIds(
                next ? [...props.toolIds, tool.id] : props.toolIds.filter((id) => id !== tool.id)
              )
            }
          />
        )
      })}
    </SettingsSection>
  )
}

const styles = themedStyleSheet(() => ({
  hero: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm
  },
  name: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
    marginTop: spacing.sm,
    textAlign: 'center'
  },
  purpose: { fontSize: 14, lineHeight: 19, color: colors.textSecondary, textAlign: 'center' },
  byline: { fontSize: 13, color: colors.textMuted, textAlign: 'center' },
  foot: { gap: spacing.sm, paddingTop: spacing.lg, paddingBottom: spacing.md },
  hint: { fontSize: 13, color: colors.textMuted, textAlign: 'center' }
}))
