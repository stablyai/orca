import type { MobileWebShellSession } from '@orca/expo-mobile-web-shell'
import type { MobileWebPackageDownloadProgress } from './mobile-web-package-downloader'
import type { MobileWebShellNotice } from './mobile-web-shell-notice'

export type MobileWebPackageSession = {
  session: MobileWebShellSession | null
  sessionHostId: string | undefined
  viewEpoch: number
  packageLoading: boolean
  packageProgress: MobileWebPackageDownloadProgress | undefined
  packageWarning: MobileWebShellNotice | undefined
  markHealthy: (sessionId: string) => Promise<void>
  handleHealthTimeout: (sessionId: string) => Promise<void>
  handleProcessTerminated: (sessionId: string) => Promise<void>
  retryPackage: () => void
  recoverPrevious: () => Promise<void>
  clearCache: () => Promise<void>
  showWarning: (message: string, code?: string) => void
}
