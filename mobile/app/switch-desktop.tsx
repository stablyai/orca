import { useLocalSearchParams } from 'expo-router'
import { SwitchDesktopScreen } from '../src/host-screen/switch-desktop-screen'
import { firstParam } from '../src/navigation/route-param-reader'

export default function SwitchDesktopRoute() {
  const params = useLocalSearchParams<{ from?: string | string[] }>()
  const from = firstParam(params.from)
  return <SwitchDesktopScreen fromHostId={from === '' ? undefined : from} />
}
