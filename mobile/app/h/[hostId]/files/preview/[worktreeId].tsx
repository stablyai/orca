import { MobileFilePreviewScreen } from '../../../../../src/files/MobileFilePreviewScreen'
import { useMobileWebRouteParams } from '../../../../../src/mobile-web/use-mobile-web-route-params'
import type { HostFilePreviewOperations } from '../../../../../src/files/host-file-preview-operations'
import { normalizeMobileFilePreviewRouteParams } from '../../../../../src/files/mobile-file-preview-route'
import type { ConnectionState } from '../../../../../src/transport/types'

export function MobileFilePreviewRoute({
  operations,
  connectionState,
  nativeHostBinding = true
}: {
  operations?: HostFilePreviewOperations
  connectionState?: ConnectionState
  nativeHostBinding?: boolean
} = {}) {
  const params = useMobileWebRouteParams<{
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
  return (
    <MobileFilePreviewScreen
      route={normalizeMobileFilePreviewRouteParams(params)}
      operations={operations}
      connectionState={connectionState}
      nativeHostBinding={nativeHostBinding}
    />
  )
}

export default MobileFilePreviewRoute
