import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { MOBILE_WEB_SOURCE_CONTROL_STATUS_LIMIT } from '../../../src/shared/mobile-web/source-control-operation-contract'

export type WebHostSourceControlStatusSnapshot = ReturnType<
  typeof createWebHostSourceControlStatusSnapshot
>

export function createWebHostSourceControlStatusSnapshot(
  client: MobileWebBridgeClient,
  workspaceId: string
) {
  type Status = Awaited<ReturnType<MobileWebBridgeClient['sourceControlStatus']>>
  let current: Status | null = null
  let pending: Promise<Status> | null = null

  const refresh = (): Promise<Status> => {
    if (pending) {
      return pending
    }
    const request = client.sourceControlStatus({
      workspaceId,
      limit: MOBILE_WEB_SOURCE_CONTROL_STATUS_LIMIT
    })
    pending = request
    void request.then(
      (status) => {
        current = status
        if (pending === request) {
          pending = null
        }
      },
      () => {
        if (pending === request) {
          pending = null
        }
      }
    )
    return request
  }

  return {
    read: (): Promise<Status> => pending ?? (current ? Promise.resolve(current) : refresh()),
    refresh
  }
}
