import type {
  GoogleSetupFileResult,
  GoogleSetupFoundKey
} from '../../shared/google/google-setup-ipc-types'

/** Window-only help for Settings › Google; see main/ipc/google-setup.ts. */
export type GoogleSetupApi = {
  /** The file picker, opened at Downloads; null when the person cancels. */
  pickClientFile: () => Promise<GoogleSetupFileResult | null>
  /** Share with teammates: the save dialog, opened at Downloads; false when cancelled. */
  saveAppFile: (args: { text: string; name: string }) => Promise<boolean>
  /** Waits for a new client_secret_*.json in Downloads and returns its text. */
  watchDownloads: () => Promise<GoogleSetupFileResult>
  stopWatchingDownloads: () => Promise<void>
  /** The newest key file already in Downloads since `since` (for the project, when given); it stays there. */
  findDownloadedKey: (args: {
    since: number
    projectId?: string
  }) => Promise<GoogleSetupFoundKey | null>
}
