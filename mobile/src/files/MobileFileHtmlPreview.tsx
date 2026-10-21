import { MobileHtmlPreview } from '../components/MobileHtmlPreview'
import { MobileFilePreviewSourceText } from './MobileFilePreviewSourceText'
import { svgPreviewDocument } from './mobile-file-svg-preview-document'

export type MobileFileHtmlPreviewProps = {
  kind: 'html' | 'svg'
  relativePath: string
  content: string
  truncated: boolean
  byteLength: number
  initialLine?: number
}

/** A rendered HTML or SVG file with its source a tab away. */
export function MobileFileHtmlPreview(props: MobileFileHtmlPreviewProps) {
  const source = (
    <MobileFilePreviewSourceText
      relativePath={props.relativePath}
      content={props.content}
      truncated={props.truncated}
      byteLength={props.byteLength}
      initialLine={props.initialLine}
    />
  )
  // Why: a line target asks for source, and a truncated SVG is invalid XML that renders blank.
  if (props.initialLine !== undefined || (props.kind === 'svg' && props.truncated)) {
    return source
  }
  return (
    <MobileHtmlPreview
      html={props.kind === 'svg' ? svgPreviewDocument(props.content) : props.content}
      renderSource={() => source}
    />
  )
}
