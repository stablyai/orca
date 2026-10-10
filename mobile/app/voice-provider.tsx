import { useLocalSearchParams, useRouter } from 'expo-router'
import VoiceProviderScreen from '../src/settings/voice-provider-screen'
import { useVoiceSettingsOperations } from '../src/settings/use-voice-settings-operations'

export default function NativeVoiceProviderRoute() {
  const router = useRouter()
  const { providerId, hostId } = useLocalSearchParams<{ providerId?: string; hostId?: string }>()
  const { operations, focused, unpaired } = useVoiceSettingsOperations(
    typeof hostId === 'string' ? hostId : undefined
  )
  return (
    <VoiceProviderScreen
      operations={operations}
      focused={focused}
      unpaired={unpaired}
      providerId={typeof providerId === 'string' ? providerId : ''}
      onBack={() => router.back()}
    />
  )
}
