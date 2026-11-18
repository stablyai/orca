// On a bot's Home Chat while something needs you: "2 items need you · View", which opens the bot panel.
import { HostRouteNoticeBanner } from '../../components/host-connection/HostRouteNoticeBanner'
import { Presence } from '../../components/motion/AutoHeight'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { MobileBotItemStatusIcon } from './MobileBotItemStatusIcon'

export function MobileBotItemsStrip({ count, onView }: { count: number; onView: () => void }) {
  const t = useMobileTranslation()
  return (
    <Presence animateHeight={false}>
      {count > 0 && (
        <HostRouteNoticeBanner
          leading={<MobileBotItemStatusIcon status="needs_you" size={8} />}
          message={t('bots.items.needYouCount', '{{count}} items need you', {
            count,
            defaultValue_one: '{{count}} item needs you'
          })}
          action={{ label: t('bots.items.strip.view', 'View'), onPress: onView }}
        />
      )}
    </Presence>
  )
}
