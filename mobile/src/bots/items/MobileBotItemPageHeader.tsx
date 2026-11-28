// The item page's header, titled with the item's number ("#528") so the heading below is the title alone:
// Back to the list, and up and down through it with "4 of 6", as the desktop's stepper steps.
import { ChevronDown, ChevronUp } from 'lucide-react-native'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { formatBotItemNumber } from '../../../../src/shared/bots/bot-items'
import type { PhoneBotItemStepper } from './use-phone-bot-item-walk'

export function MobileBotItemPageHeader({
  number,
  stepper,
  online,
  onBack
}: {
  /** Null while the item loads or when it couldn't open; the bar then reads "Item". */
  number: number | null
  /** Null when the item opened from elsewhere than the list. */
  stepper: PhoneBotItemStepper | null
  /** Offline, both arrows rest, as on the desktop. */
  online: boolean
  onBack: () => void
}) {
  const t = useMobileTranslation()
  return (
    <SheetHeader
      title={number === null ? t('bots.items.view.title', 'Item') : formatBotItemNumber(number)}
      // "#528" alone is read as "number 528"; say what it numbers.
      titleAccessibilityLabel={
        number === null
          ? undefined
          : t('bots.items.view.numberLabel', 'Item {{number}}', { number })
      }
      subtitle={
        stepper
          ? t('bots.items.view.placeOf', '{{index}} of {{total}}', {
              index: stepper.index,
              total: stepper.total
            })
          : undefined
      }
      onBack={{
        label: t('bots.panel.backTo', 'Back to {{name}}', { name: t('bots.items.tab', 'Items') }),
        onPress: onBack
      }}
      trailingButtons={
        stepper ? (
          <>
            <NavBarButton
              icon={ChevronUp}
              accessibilityLabel={t('bots.items.view.previous', 'Previous item')}
              onPress={() => stepper.step(-1)}
              disabled={!online || !stepper.canStep(-1)}
            />
            <NavBarButton
              icon={ChevronDown}
              accessibilityLabel={t('bots.items.view.next', 'Next item')}
              onPress={() => stepper.step(1)}
              disabled={!online || !stepper.canStep(1)}
            />
          </>
        ) : undefined
      }
    />
  )
}
