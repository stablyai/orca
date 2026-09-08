import { Buffer } from 'buffer/'
import {
  MOBILE_WEB_MERMAID_FRAME_SCRIPT,
  MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH,
  buildMobileWebMermaidFrameDocument
} from './mermaid-frame-document'
import { mobileWebEmbeddedFrameCsp } from '../../mobile-web/embedded-frame-csp'
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
  return buildMobileWebMermaidFrameDocument({
    theme,
    // The in-app WebView inlines both the engine and the frame script, so both are hashed.
    script: {
      inlineCsp: mobileWebEmbeddedFrameCsp(
        `${MERMAID_WEBVIEW_ENGINE_CSP_HASH} ${MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH}`
      )
    },
    embeddedEngine: MERMAID_WEBVIEW_ENGINE_GZIP_BASE64,
    encodedSource: Buffer.from(source, 'utf8').toString('base64'),
    encodedToken: Buffer.from(token, 'utf8').toString('base64')
  })
}
