import { useLocalSearchParams, useRouter } from 'expo-router'
import VoiceCloudProvidersScreen from '../src/settings/voice-cloud-providers-screen'
import { useVoiceSettingsOperations } from '../src/settings/use-voice-settings-operations'

export default function NativeVoiceCloudProvidersRoute() {
  const router = useRouter()
  const params = useLocalSearchParams<{ hostId?: string }>()
  const hostId = typeof params.hostId === 'string' ? params.hostId : undefined
  const { operations, focused, unpaired } = useVoiceSettingsOperations(hostId)
  return (
    <VoiceCloudProvidersScreen
      operations={operations}
      focused={focused}
      unpaired={unpaired}
      onBack={() => router.back()}
      onOpenProvider={(providerId) =>
        router.push({
          pathname: '/voice-provider',
          params: hostId ? { providerId, hostId } : { providerId }
        })
      }
    />
  )
}
