import { Pressable, Text, View } from 'react-native'
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

export function MobileSourceControlSegments({ active, onSelect }: Props) {
  return (
    <View style={hubStyles.segments} accessibilityRole="tablist">
      {SOURCE_CONTROL_HUB_TABS.map((tab) => {
        const isActive = tab === active
        return (
          <Pressable
            key={tab}
            style={({ pressed }) => [
              hubStyles.segment,
              isActive && hubStyles.segmentActive,
              pressed && !isActive && hubStyles.segmentPressed
            ]}
            onPress={() => onSelect(tab)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={SOURCE_CONTROL_HUB_TAB_LABELS[tab]}
          >
            <Text
              style={[hubStyles.segmentText, isActive && hubStyles.segmentTextActive]}
              numberOfLines={1}
            >
              {SOURCE_CONTROL_HUB_TAB_LABELS[tab]}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
