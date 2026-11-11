import { useLocalSearchParams, useRouter } from 'expo-router'
import { Cloud } from 'lucide-react-native'
import { useEffect, useState } from 'react'
import { SafeAreaView } from 'react-native-safe-area-context'
import { MobileStateView } from '../../../src/components/MobileStateView'
import { CloudWorkspaceScreen } from '../../../src/cloud/CloudWorkspaceScreen'
import { resolveCloudWorkspaceLink } from '../../../src/cloud/cloud-workspace-prefs'
import { loadCloudControlPlane } from '../../../src/cloud/cloud-session'
import { useMobileTranslation } from '../../../src/i18n/use-mobile-translation'
import { colors } from '../../../src/theme/mobile-theme'
import { parseCloudWorkspaceLink } from '../../../../src/shared/cloud-workspaces/cloud-workspaces-wire'

type Resolved = { kind: 'loading' } | { kind: 'found'; sandboxId: string } | { kind: 'missing' }

/** Team links with a number (orca://cloud/<org>/W-123, the desktop's "Copy link") open here. */
export default function CloudWorkspaceNumberLinkRoute() {
  const t = useMobileTranslation()
  const router = useRouter()
  const params = useLocalSearchParams<{ org?: string; number?: string }>()
  const link = `orca://cloud/${params.org ?? ''}/${params.number ?? ''}`
  const [resolved, setResolved] = useState<Resolved>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    const parsed = parseCloudWorkspaceLink(link)
    void (async () => {
      const plane = parsed ? await loadCloudControlPlane() : null
      const sandboxId =
        plane && parsed ? await resolveCloudWorkspaceLink(plane, parsed.target) : null
      if (live) {
        setResolved(sandboxId ? { kind: 'found', sandboxId } : { kind: 'missing' })
      }
    })().catch(() => live && setResolved({ kind: 'missing' }))
    return () => {
      live = false
    }
  }, [link])
  if (resolved.kind === 'found') {
    return <CloudWorkspaceScreen key={resolved.sandboxId} sandboxId={resolved.sandboxId} />
  }
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bgBase }}>
      {resolved.kind === 'loading' ? (
        <MobileStateView loading title={t('cloud.link.opening', 'Opening workspace…')} />
      ) : (
        <MobileStateView
          icon={Cloud}
          title={t('cloud.link.missingTitle', 'Can’t open this workspace')}
          message={t(
            'cloud.link.missing',
            'It’s private, in another team, or deleted. If it’s in another team, switch to it on your computer first.'
          )}
          action={{ label: t('cloud.link.home', 'Go to Home'), onPress: () => router.replace('/') }}
        />
      )}
    </SafeAreaView>
  )
}
