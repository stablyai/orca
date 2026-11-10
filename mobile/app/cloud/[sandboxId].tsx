import { useLocalSearchParams } from 'expo-router'
import { CloudWorkspaceScreen } from '../../src/cloud/CloudWorkspaceScreen'

export default function CloudWorkspaceRoute() {
  const params = useLocalSearchParams<{ sandboxId?: string; autostart?: string }>()
  const sandboxId = typeof params.sandboxId === 'string' ? params.sandboxId : ''
  return (
    <CloudWorkspaceScreen
      key={sandboxId}
      sandboxId={sandboxId}
      autostart={params.autostart === '1'}
    />
  )
}
