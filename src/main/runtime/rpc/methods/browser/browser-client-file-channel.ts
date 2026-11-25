import {
  BrowserClientFileChannelAbortParams,
  BrowserClientFileChannelBeginParams,
  BrowserClientFileChannelReadParams,
  BrowserClientFileChannelWriteParams
} from '../../../../../shared/browser/client-hosting/browser-client-file-channel-protocol'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import { getBrowserClientDownloadTransferStore } from '../../../browser/downloads/browser-client-download-transfer-store'
import { getBrowserHostLeaseRegistry } from '../../../browser-host/leases/browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from '../../../browser/client-pages/runtime-browser-page-registry'
import {
  abortClaimedClientDownload,
  beginClientDownload,
  writeClaimedClientDownload
} from '../../../browser/downloads/client-download-claims'
import { isClientPageUploadReadGranted } from '../../../browser/client-pages/client-page-upload-reads'
import { recordClientDownloadCommit } from '../../../browser/downloads/client-download-provenance'
import { defineMethod, type RpcContext } from '../../core'

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
    connectionId,
    admitPendingProfileSwitch: true
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

export const BROWSER_CLIENT_FILE_CHANNEL_METHODS = [
  defineMethod({
    name: 'browser.clientHost.fileChannel.read',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserClientFileChannelReadParams,
    handler: async (params, context) => {
      const page = requireFileChannelPage(params, context)
      const { workspaceRelativePath: path, offset, length } = params
      // An agent's upload on this host may name any file it can read, as on this host's own pages.
      const chunk = isClientPageUploadReadGranted(page.browserPageId, path)
        ? await context.runtime.readHostFileChunk(page.workspaceId, path, offset, length)
        : await context.runtime.readFileExplorerChunk(page.workspaceId, path, offset, length)
      const totalBytes = offset + chunk.bytesRead
      return {
        contentBase64: chunk.contentBase64,
        bytesRead: chunk.bytesRead,
        totalBytes,
        eof: chunk.eof
      }
    }
  }),
  defineMethod({
    name: 'browser.clientHost.fileChannel.begin',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserClientFileChannelBeginParams,
    handler: (params, context) => {
      const page = requireFileChannelPage(params, context)
      const { runtime, connectionId } = context
      // File transfers belong to one desktop connection (they don't survive a reconnect), and a
      // dropped connection sends no abort: its close fails the claim, so the agent hears why.
      const watch = `client-download-claim:${page.browserPageId}:${params.transferId}`
      const claimed = beginClientDownload(
        params.transferId,
        {
          browserPageId: page.browserPageId,
          workspaceId: page.workspaceId,
          pageHostGeneration: params.pageHostGeneration,
          filename: params.filename,
          documentUrl: params.documentUrl,
          agentDownload: params.agentDownload === true
        },
        () => runtime.cleanupSubscription(watch)
      )
      if (claimed) {
        runtime.registerSubscriptionCleanup(
          watch,
          () =>
            void abortClaimedClientDownload(
              page.browserPageId,
              params.transferId,
              'the desktop disconnected before the download finished.'
            ),
          connectionId
        )
      }
      return { accepted: true as const, claimed }
    }
  }),
  defineMethod({
    name: 'browser.clientHost.fileChannel.write',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserClientFileChannelWriteParams,
    handler: async (params, context) => {
      const page = requireFileChannelPage(params, context)
      const claimed = await writeClaimedClientDownload(params)
      if (claimed) {
        return { accepted: true as const, ...claimed }
      }
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
      if (!commit) {
        return { accepted: true as const }
      }
      recordClientDownloadCommit({
        workspaceId: page.workspaceId,
        browserPageId: page.browserPageId,
        workspaceRelativePath: commit.workspaceRelativePath,
        committedAt: Date.now()
      })
      return { accepted: true as const, workspaceRelativePath: commit.workspaceRelativePath }
    }
  }),
  defineMethod({
    name: 'browser.clientHost.fileChannel.abort',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserClientFileChannelAbortParams,
    handler: async (params, context) => {
      requireFileChannelPage(params, context)
      if (abortClaimedClientDownload(params.browserPageId, params.transferId)) {
        return { released: true }
      }
      const released = await getBrowserClientDownloadTransferStore(context.runtime).abort({
        transferId: params.transferId,
        browserPageId: params.browserPageId
      })
      return { released }
    }
  })
]
