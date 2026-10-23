import { withWorkspaceRoute } from '../../../../../src/navigation/workspace-route'
import { useLocalSearchParams } from 'expo-router'
import { MobileFilePreviewScreen } from '../../../../../src/files/MobileFilePreviewScreen'
import { normalizeMobileFilePreviewRouteParams } from '../../../../../src/files/mobile-file-preview-route'

/**
 * The page's route for the file preview: the screen itself. The native route file mounts the shell, whose
 * native view module throws at import in a browser, and the manifest imports every route.
 */
export default withWorkspaceRoute(function MobileFilePreviewRoute() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    relativePath?: string | string[]
    source?: string | string[]
    absolutePath?: string | string[]
    grantId?: string | string[]
    terminal?: string | string[]
    pathText?: string | string[]
    cwd?: string | string[]
    nativeChatTab?: string | string[]
    nativeChatSession?: string | string[]
    line?: string | string[]
    column?: string | string[]
    name?: string | string[]
    worktreeName?: string | string[]
  }>()
  return <MobileFilePreviewScreen route={normalizeMobileFilePreviewRouteParams(params)} />
})
