import { Buffer } from 'buffer/'
import {
  MOBILE_WEB_MERMAID_FRAME_SCRIPT,
  MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH,
  buildMobileWebMermaidFrameDocument
} from '../../../../src/shared/mobile-web/mermaid-frame-document'
import { colors } from '../../theme/mobile-theme'
import {
  MERMAID_WEBVIEW_ENGINE_CSP_HASH,
  MERMAID_WEBVIEW_ENGINE_GZIP_BASE64
} from './mermaid-webview-engine.generated'

export {
  MOBILE_WEB_MERMAID_FRAME_SCRIPT as MERMAID_DIAGRAM_SCRIPT,
  MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH as MERMAID_DIAGRAM_SCRIPT_CSP_HASH
}

const theme = {
  background: colors.bgRaised,
  primary: colors.bgPanel,
  text: colors.textPrimary,
  line: colors.textSecondary
}

export function buildMermaidDiagramDocument(source: string, token = ''): string {
  const document = buildMobileWebMermaidFrameDocument({
    theme,
    embeddedEngine: MERMAID_WEBVIEW_ENGINE_GZIP_BASE64,
    encodedSource: Buffer.from(source, 'utf8').toString('base64'),
    encodedToken: Buffer.from(token, 'utf8').toString('base64')
  })
  return document.replace(
    `script-src ${MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH} blob:`,
    `script-src ${MERMAID_WEBVIEW_ENGINE_CSP_HASH} ${MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH}`
  )
}
