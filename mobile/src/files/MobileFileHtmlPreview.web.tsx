import { MobileFilePreviewSourceText } from './MobileFilePreviewSourceText'
// The native component's own prop type, so a change to it fails here rather than drifting.
import type { MobileFileHtmlPreviewProps } from './MobileFileHtmlPreview'

/**
 * Web sibling: source only, as the file preview page showed before the native render.
 *
 * Why: rendering here would pull MobileHtmlPreview.web and its link-grant seam into the file
 * preview page, whose shell manifest entry grants no externalNavigation.
 */
export function MobileFileHtmlPreview(props: MobileFileHtmlPreviewProps) {
  return (
    <MobileFilePreviewSourceText
      relativePath={props.relativePath}
      content={props.content}
      truncated={props.truncated}
      byteLength={props.byteLength}
      initialLine={props.initialLine}
    />
  )
}
