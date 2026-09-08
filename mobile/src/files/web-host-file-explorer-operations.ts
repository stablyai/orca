import { MOBILE_WEB_FILE_DIRECTORY_LIMIT } from '../../../src/shared/mobile-web/file-operation-contract'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostFileExplorerOperations } from './host-file-explorer-operations'

export function webHostFileExplorerOperations(
  client: MobileWebBridgeClient
): HostFileExplorerOperations {
  return {
    async readDirectory(workspaceId, relativePath) {
      const result = await client.fileDirectory({
        workspaceId,
        relativePath,
        limit: MOBILE_WEB_FILE_DIRECTORY_LIMIT
      })
      return {
        kind: 'directory',
        entries: result.entries,
        truncated: result.truncated
      }
    },
    async reconnect() {
      await client.navigationReconnect()
    }
  }
}
