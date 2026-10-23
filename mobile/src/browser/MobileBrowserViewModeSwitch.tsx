import { Monitor, Smartphone } from 'lucide-react-native'
import { IconButton } from '../components/ui/IconButton'
import { triggerSelection } from '../platform/haptics'
import type { MobileBrowserViewMode } from './browser-screencast-request'

type Props = {
  disabled: boolean
  value: MobileBrowserViewMode
  onChange: (mode: MobileBrowserViewMode) => void
}

/** One button that shows which site the page is rendering, web or mobile, and flips it. */
export function MobileBrowserViewModeSwitch({
  disabled,
  value,
  onChange
}: Props): React.JSX.Element {
  const next: MobileBrowserViewMode = value === 'web' ? 'mobile' : 'web'
  return (
    <IconButton
      icon={value === 'web' ? Monitor : Smartphone}
      variant="bare"
      iconSize={19}
      disabled={disabled}
      selected={value === 'mobile'}
      onPress={() => {
        triggerSelection()
        onChange(next)
      }}
      accessibilityLabel={`Show ${next} website view`}
    />
  )
}
