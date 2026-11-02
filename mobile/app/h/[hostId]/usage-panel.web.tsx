import { useLocalSearchParams } from 'expo-router'
import { MobileUsagePanelScreen } from '../../../src/usage-panel/MobileUsagePanelScreen'
import { firstParam } from '../../../src/navigation/route-param-reader'

export default function MobileUsagePanelRoute() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)
  return <MobileUsagePanelScreen key={hostId} />
}
