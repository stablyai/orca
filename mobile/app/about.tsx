import { Linking, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import AboutScreen from '../src/settings/about-screen'

// Why: read version + native build identifier from expo-constants at
// runtime so the About screen never drifts out of sync with app.json.
// nativeBuildVersion is iOS buildNumber on iOS and versionCode on
// Android — different concepts, same role (monotonic native build id).
function getVersionLabel(): string {
  const version = Constants.expoConfig?.version ?? '?.?.?'
  const build =
    Platform.OS === 'ios'
      ? Constants.expoConfig?.ios?.buildNumber
      : String(Constants.expoConfig?.android?.versionCode ?? '')
  return build ? `v${version} (${build})` : `v${version}`
}

export default function NativeAboutRoute() {
  const router = useRouter()
  return (
    <AboutScreen
      onBack={() => router.back()}
      openExternal={(url) => Linking.openURL(url)}
      versionLabel={getVersionLabel()}
    />
  )
}
