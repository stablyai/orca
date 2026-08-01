import { useLocalSearchParams } from 'expo-router'
import { MobileAgentsScreen } from '../../../src/agents/MobileAgentsScreen'

export default function AgentsRoute(): React.JSX.Element {
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  return <MobileAgentsScreen hostId={hostId} />
}
