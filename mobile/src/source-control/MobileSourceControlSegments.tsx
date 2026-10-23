import { View } from 'react-native'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import {
  SOURCE_CONTROL_HUB_TABS,
  SOURCE_CONTROL_HUB_TAB_LABELS,
  type SourceControlHubTab
} from './mobile-source-control-hub-tab'
import { hubStyles } from './mobile-source-control-hub-styles'

type Props = {
  active: SourceControlHubTab
  onSelect: (tab: SourceControlHubTab) => void
}

const SEGMENTS = SOURCE_CONTROL_HUB_TABS.map((tab) => ({
  value: tab,
  label: SOURCE_CONTROL_HUB_TAB_LABELS[tab]
}))

// The hub's top-level lens switcher. Switching is local state (no route push) so
// scroll position and the shared branch header persist across Changes/PR/History.
export function MobileSourceControlSegments({ active, onSelect }: Props) {
  return (
    <View style={hubStyles.segments}>
      <MobileSegmentedControl
        segments={SEGMENTS}
        selected={active}
        onSelect={onSelect}
        testIDPrefix="source-control-tab-"
        fill
      />
    </View>
  )
}
