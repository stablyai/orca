import { useRouter } from 'expo-router'
import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import AboutScreen from '../src/settings/about-screen'

export default function HostedAboutRoute() {
  const router = useRouter()
  const shell = useMobileWebNativeShell()
  return (
    <AboutScreen
      onBack={() => {
        if (router.canGoBack()) {
          router.back()
        } else {
          router.replace('/settings')
        }
      }}
      linksAvailable={shell.client?.native.supports('openExternal') ?? false}
      openExternal={async (url) => {
        if (!shell.client) {
          throw new Error('Native shell channel unavailable')
        }
        await shell.client.native.openExternal(url)
      }}
      versionLabel={
        shell.context
          ? `Interface build ${shell.context.buildId.slice(0, 12)}`
          : 'Loading interface build…'
      }
    />
  )
}
