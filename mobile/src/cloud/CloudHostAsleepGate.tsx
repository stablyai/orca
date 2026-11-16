import { useRouter } from 'expo-router'
import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { MobileStateView } from '../components/feedback/MobileStateView'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsNavBar } from '../settings/settings-screen-frame'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { CloudStateGlyph } from './CloudStateGlyph'
import { cloudHostGate } from './cloud-screen-states'
import { cloudWorkspaceIdForHost } from './cloud-workspace-links'
import { useCloudEnrollment, useCloudWorkspace } from './use-cloud-workspaces'

/**
 * A cloud workspace's VM is a paired host, but an asleep one is not "a computer that's offline":
 * before its page loads, say it's asleep and offer Wake (the normal wake → access → connect flow,
 * which lands back on this host). Every other host, and a cloud host that is up, passes through.
 * One component with fixed hooks, and the page is mounted only once the answer is known, so it is
 * never mounted and then thrown away.
 */
export function CloudHostAsleepGate(props: { hostId: string; children: ReactNode }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  // The answer is kept with the host it was looked up for: a gate reused for another host waits
  // instead of reading the previous host's workspace for a render.
  const [lookup, setLookup] = useState<{ hostId: string; sandboxId: string | null } | null>(null)
  useEffect(() => {
    let live = true
    const hostId = props.hostId
    void cloudWorkspaceIdForHost(hostId)
      .then((id) => live && setLookup({ hostId, sandboxId: id }))
      .catch(() => live && setLookup({ hostId, sandboxId: null }))
    return () => {
      live = false
    }
  }, [props.hostId])
  const sandboxId = lookup?.hostId === props.hostId ? lookup.sandboxId : undefined
  const enrollment = useCloudEnrollment()
  const listed = useCloudWorkspace(enrollment, sandboxId ?? '')
  const gate = cloudHostGate({
    sandboxId,
    enrollment,
    isPending: listed.isPending,
    isError: listed.isError,
    status: listed.workspace?.status ?? null
  })
  if (gate === 'pass') {
    return props.children
  }
  if (gate === 'wait') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    )
  }
  const sleeping = listed.workspace
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bgBase }} edges={['top']}>
      <SettingsNavBar title={sleeping?.title ?? ''} onBack={() => router.back()} />
      <MobileStateView
        iconElement={<CloudStateGlyph status="sleeping" />}
        title={t('cloud.host.asleep', '{{name}} is asleep', { name: sleeping?.title ?? '' })}
        message={t('cloud.host.asleepDetail', 'Files are kept. Wake it to keep working.')}
        action={{
          label: t('cloud.host.wake', 'Wake'),
          onPress: () => router.replace(`/cloud/${encodeURIComponent(sandboxId ?? '')}?autostart=1`)
        }}
      />
    </SafeAreaView>
  )
}
