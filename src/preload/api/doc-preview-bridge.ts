import { ipcRenderer } from 'electron'
import {
  DOC_PREVIEW_EXTERNAL_LINK_CHANNEL,
  DOC_PREVIEW_LOAD_FAILURE_CHANNEL,
  DOC_PREVIEW_AUTHORIZE_DIRECTORY_CHANNEL,
  DOC_PREVIEW_MINT_GRANT_CHANNEL,
  DOC_PREVIEW_REVOKE_GRANT_CHANNEL,
  type DocPreviewFailure
} from '../../shared/doc-preview-scheme'
import type { DocPreviewGrantRequest } from '../api/doc-preview-api'
import type { PreloadApi } from '../api-types'

export const docPreviewApi = {
  mintGrant: (request: DocPreviewGrantRequest): Promise<{ grantId: string; url: string }> =>
    ipcRenderer.invoke(DOC_PREVIEW_MINT_GRANT_CHANNEL, request),
  revokeGrant: (grantId: string): Promise<boolean> =>
    ipcRenderer.invoke(DOC_PREVIEW_REVOKE_GRANT_CHANNEL, grantId),
  authorizeDirectory: (grantId: string, relativePath: string): Promise<boolean> =>
    ipcRenderer.invoke(DOC_PREVIEW_AUTHORIZE_DIRECTORY_CHANNEL, grantId, relativePath),
  onExternalLink: (callback: (payload: { url: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { url: string }): void =>
      callback(payload)
    ipcRenderer.on(DOC_PREVIEW_EXTERNAL_LINK_CHANNEL, listener)
    return () => ipcRenderer.removeListener(DOC_PREVIEW_EXTERNAL_LINK_CHANNEL, listener)
  },
  onLoadFailure: (callback: (payload: DocPreviewFailure) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DocPreviewFailure): void =>
      callback(payload)
    ipcRenderer.on(DOC_PREVIEW_LOAD_FAILURE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(DOC_PREVIEW_LOAD_FAILURE_CHANNEL, listener)
  }
} satisfies PreloadApi['docPreview']
