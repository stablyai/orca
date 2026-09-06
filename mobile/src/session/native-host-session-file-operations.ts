import { resolveMobileFileTabDoc, type MobileFileTabDocRequest } from '../files/mobile-file-tab-doc'
import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionFileOperations } from './host-session-file-operations'

export function nativeHostSessionFileOperations(client: RpcClient): HostSessionFileOperations {
  return {
    readTab(request: MobileFileTabDocRequest) {
      return resolveMobileFileTabDoc(client, request)
    }
  }
}
