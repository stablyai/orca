import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import { mediaHandoffMimeFor } from './mobile-file-media-handoff'
import { defaultScheduleTimer } from '../transport/timer-scheduler'
import {
  createMobileFilePreviewHref,
  type MobileFilePreviewHref,
  type MobileFilePreviewRouteParams
} from './mobile-file-preview-route'

export type MobileFilePreviewRouter = {
  push: (href: MobileFilePreviewHref) => void
}

type NavigateOptions = {
  embedded?: boolean
  onRequestClose?: () => void
  scheduleClose?: (callback: () => void, delayMs: number) => unknown
}

export function navigateToMobileFilePreview(
  router: MobileFilePreviewRouter,
  params: MobileFilePreviewRouteParams,
  options: NavigateOptions = {}
): void {
  router.push(createMobileFilePreviewHref(params))
  if (options.embedded && options.onRequestClose) {
    // Why: closing the dock immediately can unmount the subtree before Expo
    // commits the route transition.
    const scheduleClose = options.scheduleClose ?? defaultScheduleTimer
    scheduleClose(options.onRequestClose, 0)
  }
}

export function canPreviewMobileFileRow(item: {
  kind: 'text' | 'binary'
  relativePath: string
}): boolean {
  if (item.kind === 'text') {
    return true
  }
  // Raster images render in the viewer; PDF/media binaries open the OS handoff
  // screen. Both are tappable rows — anything else stays unavailable.
  return (
    classifyMobileArtifact(item.relativePath) === 'image' ||
    mediaHandoffMimeFor(item.relativePath) !== null
  )
}
