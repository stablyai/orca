import {
  BrowserClientFileChannelAbortParams,
  BrowserClientFileChannelReadParams,
  BrowserClientFileChannelWriteParams
} from '../../../../shared/browser-client-file-channel-protocol'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { getBrowserClientDownloadTransferStore } from '../../browser-client-download-transfer-store'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from '../../runtime-browser-page-registry'
import { defineMethod, type RpcAnyMethod, type RpcContext } from '../core'

type FileChannelAuthorityParams = {
  browserHostClientId: string
  browserHostGeneration: number
  browserPageId: string
  pageHostGeneration: number
  authorityRuntimeId: string
}

function requireFileChannelPage(
  params: FileChannelAuthorityParams,
  context: Pick<
    RpcContext,
    'runtime' | 'pairedDeviceId' | 'connectionId' | 'clientKind' | 'clientCapabilities'
  >
) {
  const { runtime, pairedDeviceId, connectionId, clientKind, clientCapabilities } = context
  if (clientKind !== 'runtime' || !pairedDeviceId || !connectionId) {
    throw new Error('authenticated_browser_client_host_required')
  }
  if (!clientCapabilities?.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY)) {
    throw new Error('browser_client_host_capability_required')
  }
  if (params.authorityRuntimeId !== runtime.getRuntimeId()) {
    throw new Error('browser_client_host_authority_mismatch')
  }
  const leases = getBrowserHostLeaseRegistry(runtime)
  const placement = {
    kind: 'client' as const,
    browserHostClientId: params.browserHostClientId,
    browserHostGeneration: params.browserHostGeneration,
    pageHostGeneration: params.pageHostGeneration
  }
  leases.requireClientPageConnection({
    browserPageId: params.browserPageId,
    placement,
    pairedDeviceId,
    connectionId
  })
  if (
    leases.requireLease({
      authorityEpoch: leases.authorityEpoch,
      browserHostClientId: params.browserHostClientId,
      browserHostGeneration: params.browserHostGeneration,
      pairedDeviceId
    }).fileChannelProtocolVersion !== 1
  ) {
    throw new Error('browser_client_file_channel_unsupported')
  }
  const page = getRuntimeBrowserPageRegistry(runtime).getPage(params.browserPageId)
  if (!page) {
    throw new Error('browser_runtime_page_required')
  }
  return page
}

export const BROWSER_CLIENT_FILE_CHANNEL_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'browser.clientHost.fileChannel.read',
    params: BrowserClientFileChannelReadParams,
    handler: async (params, context) => {
      const page = requireFileChannelPage(params, context)
      const chunk = await context.runtime.readFileExplorerChunk(
        page.workspaceId,
        params.workspaceRelativePath,
        params.offset,
        params.length
      )
      const totalBytes = params.offset + chunk.bytesRead
      return {
        contentBase64: chunk.contentBase64,
        bytesRead: chunk.bytesRead,
        totalBytes,
        eof: chunk.eof
      }
    }
  }),
  defineMethod({
    name: 'browser.clientHost.fileChannel.write',
    params: BrowserClientFileChannelWriteParams,
    handler: async (params, context) => {
      const page = requireFileChannelPage(params, context)
      const commit = await getBrowserClientDownloadTransferStore(context.runtime).accept({
        transferId: params.transferId,
        browserPageId: params.browserPageId,
        pageHostGeneration: params.pageHostGeneration,
        workspaceId: page.workspaceId,
        filename: params.filename,
        contentBase64: params.contentBase64,
        offset: params.offset,
        final: params.final,
        platform: process.platform
      })
      return commit
        ? { accepted: true as const, workspaceRelativePath: commit.workspaceRelativePath }
        : { accepted: true as const }
    }
  }),
  defineMethod({
    name: 'browser.clientHost.fileChannel.abort',
    params: BrowserClientFileChannelAbortParams,
    handler: async (params, context) => {
      requireFileChannelPage(params, context)
      const released = await getBrowserClientDownloadTransferStore(context.runtime).abort({
        transferId: params.transferId,
        browserPageId: params.browserPageId
      })
      return { released }
    }
  })
]
