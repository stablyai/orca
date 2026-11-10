import { ListRow } from './list/ListGroup'
import { MobileSwitch } from './MobileSwitch'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

/** The Smart rail setting: keys for what the terminal's agent is doing, at the front of the key row. */
export function SmartRailRow({
  enabled,
  onChange
}: {
  enabled: boolean
  onChange: (enabled: boolean) => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  const title = t('components.smartRailRow.title', 'Smart rail')
  return (
    <ListRow
      title={title}
      subtitle={t('components.smartRailRow.subtitle', 'Shows keys for what your agent is doing')}
      accessory={
        <MobileSwitch accessibilityLabel={title} value={enabled} onValueChange={onChange} />
      }
    />
  )
}
