import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import { PageRouteUnavailableScreen } from './PageRouteUnavailableScreen'

// Never nest a native shell inside its own page; native view imports throw in browsers. Refuse unbuilt page paths visibly instead of redirecting into Expo’s Unmatched.
export default function MobileWebPageCatchAllScreen() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  return <PageRouteUnavailableScreen hostId={firstParam(params.hostId)} />
}
