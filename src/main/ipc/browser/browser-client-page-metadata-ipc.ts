import { ipcMain } from 'electron'
import { publishBrowserClientPageMetadata } from '../../browser/client-pages/renderer/browser-client-page-metadata-transport'
import {
  BrowserClientPageMetadataParams,
  type BrowserClientPageMetadataPublishOutcome
} from '../../../shared/browser/client-hosting/browser-client-page-metadata-protocol'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

type BrowserMetadataIpc = Pick<typeof ipcMain, 'handle'>

function browserClientPageMetadataErrorCode(error: unknown): string {
  if (error instanceof RemoteRuntimeClientError) {
    return error.code
  }
  return error instanceof Error ? error.message : 'browser_client_page_metadata_failed'
}

// Publish through main's attached browser-host lease; direct renderer traffic would be refused as stale.
export function registerBrowserClientPageMetadataHandler(ipc: BrowserMetadataIpc = ipcMain): void {
  ipc.handle(
    'browser:publishClientPageMetadata',
    async (
      event,
      args: { environmentId: string; params: unknown }
    ): Promise<BrowserClientPageMetadataPublishOutcome> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { status: 'refused' }
      }
      if (typeof args?.environmentId !== 'string' || !args.environmentId) {
        return { status: 'refused' }
      }
      const params = BrowserClientPageMetadataParams.safeParse(args.params)
      if (!params.success) {
        return { status: 'refused' }
      }
      try {
        return {
          status: 'published',
          ...(await publishBrowserClientPageMetadata(args.environmentId, params.data))
        }
      } catch (error) {
        return { status: 'failed', errorCode: browserClientPageMetadataErrorCode(error) }
      }
    }
  )
}
