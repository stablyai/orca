import { useCallback, useMemo, useState } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import VoiceSettingsScreen from '../src/settings/voice-settings-screen'
import { webVoiceSettingsOperations } from '../src/settings/web-voice-settings-operations'

export default function HostedVoiceSettingsRoute() {
  const router = useRouter()
  const shell = useMobileWebNativeShell()
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const client = shell.client
  const operations = useMemo(() => (client ? webVoiceSettingsOperations(client) : null), [client])
  return (
    <VoiceSettingsScreen
      key={shell.context?.shellSessionId ?? 'pending'}
      operations={operations}
      focused={focused}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
    />
  )
}
