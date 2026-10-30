import { PickerModal } from '../components/PickerModal'
import { StatusDot } from '../components/StatusDot'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { HostSwitcher } from './use-host-switcher'

export function HostSwitcherSheet({ switcher }: { switcher: HostSwitcher }) {
  const t = useMobileTranslation()
  const { options, ...props } = switcher.pickerProps
  return (
    <PickerModal
      title={t('hostScreen.hostSwitcherSheet.title', 'Switch Desktop')}
      {...props}
      options={options.map(({ state, ...option }) => ({
        ...option,
        renderIcon: () => <StatusDot state={state} />
      }))}
    />
  )
}
