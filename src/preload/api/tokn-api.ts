import type {
  ToknConnectResult,
  ToknSyncStatus,
  ToknUploadPreview
} from '../../shared/tokn-sync-status'

/** Desktop only: publishes this computer's tracked Claude Code and Codex totals to tokn. */
export type ToknApi = {
  getStatus: () => Promise<ToknSyncStatus>
  /** Opens tokn in the browser and resolves once the sign-in finishes, is cancelled, or times out. */
  connect: () => Promise<ToknConnectResult>
  cancelConnect: () => Promise<ToknSyncStatus>
  /** Forgets the token locally and revokes it on tokn. */
  disconnect: () => Promise<ToknSyncStatus>
  syncNow: () => Promise<ToknSyncStatus>
  previewUpload: () => Promise<ToknUploadPreview>
}
