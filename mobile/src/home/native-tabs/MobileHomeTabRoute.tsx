import { useIsFocused } from 'expo-router'
import { useState } from 'react'
import { Alert } from 'react-native'
import { Plus } from '../../components/icons/app-icons'
import type { ScreenHeaderAction } from '../../components/nav-bar/ScreenHeader'
import { spacing } from '../../theme/mobile-theme'
import type { HomeCreateAction } from '../use-mobile-home-controller'
import type { HomeTabId } from '../tabs/home-tabs'
import { MobileHomeTabContent } from '../tabs/MobileHomeTabContent'
import { useMobileHome } from './mobile-home-context'

function headerCreateAction(create: HomeCreateAction | null): ScreenHeaderAction | undefined {
  if (!create) {
    return undefined
  }
  return {
    id: 'create',
    icon: Plus,
    label: create.label,
    // A bar button can't show a hint beside it, so a disabled one with a reason says it on tap.
    disabled: create.disabled && create.hint === undefined,
    onPress: () => (create.disabled ? Alert.alert(create.label, create.hint) : create.onPress())
  }
}

/** One native Home tab. Its body mounts on first visit, as the drawn bar's tabs do. */
export function MobileHomeTabRoute({ tab }: { tab: HomeTabId }) {
  const home = useMobileHome()
  const focused = useIsFocused()
  const [visited, setVisited] = useState(focused)
  const [automationsHostId, setAutomationsHostId] = useState<string | null>(null)
  if (focused && !visited) {
    setVisited(true)
  }
  if (!visited) {
    return null
  }
  return (
    <MobileHomeTabContent
      id={tab}
      home={home}
      bottomInset={spacing.xl}
      createAction={headerCreateAction(home.createAction(tab, automationsHostId))}
      onAutomationsHostChange={setAutomationsHostId}
    />
  )
}
