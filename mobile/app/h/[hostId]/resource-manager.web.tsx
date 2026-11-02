import { useLocalSearchParams } from 'expo-router'
import { MobileResourceManagerScreen } from '../../../src/resource-manager/MobileResourceManagerScreen'
import { firstParam } from '../../../src/navigation/route-param-reader'

export default function MobileResourceManagerRoute() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)
  return <MobileResourceManagerScreen key={hostId} />
}
