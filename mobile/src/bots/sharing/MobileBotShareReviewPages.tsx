// A received link's review pages: each part's items, and each item's exact text as Create writes it.
// The desktop's BotShareReviewPages.
import { BOT_SHARE_MEMORY_INDEX } from '../../../../src/shared/bots/bot-share-received'
import { reviewPartFiles, toolHost } from '../../../../src/shared/bots/bot-share-review-files'
import { ListRow, SectionHeader } from '../../components/list/ListGroup'
import { intlLocaleFor } from '../../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../../i18n/use-mobile-translation'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { botShareFlagLabel } from './bot-share-copy'
import {
  FlagMark,
  ReviewToolTicks,
  flagOf,
  reviewAccounts,
  reviewFlagPage,
  type ReviewContext,
  type ReviewPage
} from './MobileBotShareReview'
import { FlagLine, FlagRow, ShareFileList } from './MobileBotShareFiles'
import { eventWhen, scheduleWhen, type SharePartPage } from './mobile-share-pages'

export function MobileBotShareReviewPage(props: { page: ReviewPage; ctx: ReviewContext }) {
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const { page, ctx } = props
  const { review } = ctx
  const { bot } = review
  if (page.kind === 'part') {
    return (
      <ShareFileList
        files={reviewPartFiles(review, page.part)}
        showNames={page.showNames === true}
      />
    )
  }
  const part = (entry: Omit<SharePartPage, 'kind'>) => () => ctx.open({ kind: 'part', ...entry })
  switch (page.list) {
    case 'skills':
      return (
        <SettingsSection first>
          {bot.skills.map(({ name }) => {
            const spots = ctx.spots.filter((spot) => spot.part === `skill:${name}`)
            const [flag] = spots
            return (
              <ListRow
                key={name}
                title={name}
                subtitle={
                  flag
                    ? undefined
                    : t('bots.share.review.files', '{{count}} files', {
                        count: reviewPartFiles(review, `skill:${name}`).length
                      })
                }
                detail={
                  flag ? (
                    <FlagLine secret={spots.some((spot) => spot.flag.kind === 'secret')}>
                      {flag.flag.line === null
                        ? botShareFlagLabel(flag.flag.kind, t)
                        : t('bots.share.review.flagLine', '{{flag}}, line {{line}}', {
                            flag: botShareFlagLabel(flag.flag.kind, t),
                            line: flag.flag.line
                          })}
                    </FlagLine>
                  ) : undefined
                }
                navigates
                onPress={part({ part: `skill:${name}`, title: name, showNames: true })}
              />
            )
          })}
        </SettingsSection>
      )
    case 'automations':
      return (
        <SettingsSection first>
          {bot.schedules.map((schedule) => (
            <ListRow
              key={schedule.id}
              title={schedule.name}
              subtitle={scheduleWhen(schedule.rrule, t, intlLocale)}
              value={t('bots.share.review.off', 'Off')}
              navigates
              onPress={part({
                part: `schedule:${schedule.id}`,
                title: schedule.name,
                detail: scheduleWhen(schedule.rrule, t, intlLocale)
              })}
            />
          ))}
          {bot.eventSuggestions.map((event) => {
            const when = t('bots.share.review.suggested', 'Suggested · {{when}}', {
              when: eventWhen(event.source, event.event, t).toLowerCase()
            })
            return (
              <ListRow
                key={event.id}
                title={event.name}
                subtitle={when}
                navigates
                onPress={part({ part: `event:${event.id}`, title: event.name, detail: when })}
              />
            )
          })}
        </SettingsSection>
      )
    case 'tools':
      return ctx.consent ? (
        <ReviewToolTicks review={review} {...ctx.consent} first />
      ) : (
        <SettingsSection first>
          {bot.tools.map((tool) => (
            <ListRow key={tool.id} title={tool.name} subtitle={toolHost(tool.url)} />
          ))}
        </SettingsSection>
      )
    case 'accounts': {
      const note = reviewPartFiles(review, 'note')
      return (
        <>
          {bot.connectors.length > 0 ? (
            <SettingsSection first>
              {reviewAccounts(review).map((account) => (
                <ListRow key={account} title={account} />
              ))}
            </SettingsSection>
          ) : null}
          {note.length > 0 ? (
            <>
              <SectionHeader title={t('bots.share.setupNote', 'Setup note')} />
              <ShareFileList files={note} showNames={false} />
            </>
          ) : null}
        </>
      )
    }
    case 'memory':
      return (
        <SettingsSection first>
          {bot.memory.map(({ topic }) => (
            <ListRow
              key={topic}
              title={topic}
              accessory={<FlagMark flag={flagOf(ctx.spots, `memory:${topic}`)} />}
              navigates
              onPress={part({
                part: `memory:${topic}`,
                title: topic,
                detail: t('bots.share.memory', 'Memory')
              })}
            />
          ))}
          {reviewPartFiles(review, 'memory-index').length > 0 ? (
            <ListRow
              title={BOT_SHARE_MEMORY_INDEX}
              subtitle={t(
                'bots.share.review.memoryIndex',
                'Its memory index, with the shared notes'
              )}
              navigates
              onPress={part({
                part: 'memory-index',
                title: BOT_SHARE_MEMORY_INDEX,
                detail: t(
                  'bots.share.review.memoryIndex',
                  'Its memory index, with the shared notes'
                )
              })}
            />
          ) : null}
        </SettingsSection>
      )
    case 'check':
      return (
        <SettingsSection first>
          {ctx.spots.map((spot) => {
            const target = reviewFlagPage(spot, t)
            return (
              <FlagRow
                key={`${spot.flag.where}:${spot.flag.line}:${spot.flag.kind}`}
                spot={spot}
                onOpen={target ? () => ctx.open(target) : null}
              />
            )
          })}
        </SettingsSection>
      )
    case 'leftOut':
      return (
        <SettingsSection first>
          {review.leftOut.map((entry) => (
            <ListRow
              key={entry}
              title={entry}
              subtitle={t('bots.share.review.notIncluded', 'Not included')}
            />
          ))}
        </SettingsSection>
      )
  }
}
