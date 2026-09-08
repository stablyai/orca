import type {
  MobileFilePreviewResult,
  MobileFilePreviewSource
} from './mobile-file-preview-request'
import type { MobileTerminalArtifactPreviewSource } from './mobile-terminal-artifact-grant-refresh'

export type HostFilePreviewLoadOptions = {
  onTerminalArtifactSourceRefreshed?: (source: MobileTerminalArtifactPreviewSource) => void
}

export type HostFilePreviewSaveOptions = HostFilePreviewLoadOptions & {
  baseContent?: string
}

export type HostFilePreviewOperations = {
  load(
    source: MobileFilePreviewSource,
    options?: HostFilePreviewLoadOptions
  ): Promise<MobileFilePreviewResult>
  saveTerminalArtifact(
    source: MobileTerminalArtifactPreviewSource,
    content: string,
    options?: HostFilePreviewSaveOptions
  ): Promise<MobileFilePreviewResult | { status: 'saved' }>
  reconnect(): Promise<void>
  openExternalUrl(url: string): Promise<void>
}
