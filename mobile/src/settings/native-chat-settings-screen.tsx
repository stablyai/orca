import { useMobileDefaultSessionViewPreference } from '../session/use-mobile-default-session-view-preference'
import { ListRow } from '../components/ui/ListRow'
import { triggerSelection } from '../platform/haptics'
import { SettingsScreen, SettingsSection } from './settings-screen-frame'

type DefaultView = 'chat' | 'terminal'

const VIEW_OPTIONS: { value: DefaultView; title: string; subtitle: string }[] = [
  { value: 'chat', title: 'Chat UI', subtitle: 'A chat view like the desktop app.' },
  { value: 'terminal', title: 'Terminal', subtitle: 'The raw agent CLI.' }
]

export default function NativeChatSettingsScreen({ onBack }: { onBack?: () => void }) {
  const { defaultView, setDefaultView } = useMobileDefaultSessionViewPreference()
  const selected: DefaultView = defaultView === 'chat' ? 'chat' : 'terminal'

  return (
    <SettingsScreen title="Chat UI" onBack={onBack}>
      <SettingsSection
        title="Open agent sessions in"
        first
        footer="Switch any single session from its long-press menu."
      >
        {VIEW_OPTIONS.map((option) => (
          <ListRow
            key={option.value}
            title={option.title}
            subtitle={option.subtitle}
            selected={selected === option.value}
            accessibilityLabel={
              option.value === 'chat' ? 'Open sessions in Chat UI' : 'Open sessions in Terminal'
            }
            onPress={() => {
              if (selected !== option.value) {
                triggerSelection()
                setDefaultView(option.value)
              }
            }}
          />
        ))}
      </SettingsSection>
    </SettingsScreen>
  )
}
