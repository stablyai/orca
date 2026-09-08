import {
  MobileWebSourceControlDiffPayloadSchema,
  MobileWebSourceControlDiffResultSchema,
  MobileWebSourceControlStatusPayloadSchema,
  MobileWebSourceControlStatusResultSchema,
  type MobileWebSourceControlDiffPayload,
  type MobileWebSourceControlDiffResult,
  type MobileWebSourceControlStatusPayload,
  type MobileWebSourceControlStatusResult
} from '../../shared/mobile-web/source-control-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { withPageWorkspaceId } from './mobile-web-host-workspace-result'
import { MobileWebSourceControlHostClient } from './mobile-web-source-control-host-client'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'

export class MobileWebSourceControlReadClient extends MobileWebSourceControlHostClient {
  status(
    payload: MobileWebSourceControlStatusPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlStatusResult> {
    return this.host(
      MobileWebSourceControlStatusPayloadSchema,
      payload,
      'mobileWeb.sourceControl.status',
      { limit: payload.limit },
      options
    ).then((result) => {
      const parsed = MobileWebSourceControlStatusResultSchema.parse(
        withPageWorkspaceId(result, payload.workspaceId)
      )
      if (parsed.entries.length > payload.limit) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return parsed
    })
  }

  diff(
    payload: MobileWebSourceControlDiffPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlDiffResult> {
    return this.host(
      MobileWebSourceControlDiffPayloadSchema,
      payload,
      'mobileWeb.sourceControl.diff',
      {
        relativePath: payload.relativePath,
        area: payload.area,
        offset: payload.offset,
        limit: payload.limit,
        ...(payload.expectedRevision ? { expectedRevision: payload.expectedRevision } : {})
      },
      options
    ).then((result) => {
      const parsed = MobileWebSourceControlDiffResultSchema.parse(
        withPageWorkspaceId(result, payload.workspaceId)
      )
      if (
        parsed.relativePath !== payload.relativePath ||
        parsed.area !== payload.area ||
        (parsed.kind === 'text' &&
          (parsed.offset !== payload.offset ||
            parsed.rows.length > payload.limit ||
            (payload.expectedRevision !== undefined &&
              parsed.revision !== payload.expectedRevision)))
      ) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return parsed
    })
  }
}
