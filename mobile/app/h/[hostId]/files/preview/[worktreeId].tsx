import { useLocalSearchParams } from 'expo-router'
import { MobileFilePreviewScreen } from '../../../../../src/files/MobileFilePreviewScreen'
import { normalizeMobileFilePreviewRouteParams } from '../../../../../src/files/mobile-file-preview-route'

export default function MobileFilePreviewRoute() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    relativePath?: string | string[]
    name?: string | string[]
    worktreeName?: string | string[]
  }>()
  return <MobileFilePreviewScreen route={normalizeMobileFilePreviewRouteParams(params)} />
}
