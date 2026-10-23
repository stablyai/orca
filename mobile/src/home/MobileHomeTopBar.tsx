import { Settings } from 'lucide-react-native'
import { IconButton } from '../components/ui/IconButton'
import { NavBar } from '../components/ui/NavBar'

/** Home's bar: "Orca", shown once the large title has scrolled away, and Settings. */
export function MobileHomeTopBar({
  onOpenSettings,
  titleVisible = true,
  scrolled = false
}: {
  onOpenSettings: () => void
  titleVisible?: boolean
  scrolled?: boolean
}) {
  return (
    <NavBar
      title="Orca"
      titleVisible={titleVisible}
      scrolled={scrolled}
      trailing={
        <IconButton icon={Settings} accessibilityLabel="Settings" onPress={onOpenSettings} />
      }
    />
  )
}
