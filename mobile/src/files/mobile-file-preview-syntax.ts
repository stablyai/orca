import {
  highlightMobileCode,
  resolveMobileSyntaxLanguage,
  type MobileSyntaxSegment
} from '../session/mobile-file-syntax'

export type MobileFilePreviewSyntax = {
  language: string
  segments: MobileSyntaxSegment[]
}

export function buildMobileFilePreviewSyntax(
  relativePath: string,
  content: string
): MobileFilePreviewSyntax {
  try {
    const language = resolveMobileSyntaxLanguage(relativePath)
    const result = highlightMobileCode(content, language)
    return {
      language,
      segments: result.segments.length > 0 ? result.segments : plainSegments(content)
    }
  } catch {
    return { language: 'plaintext', segments: plainSegments(content) }
  }
}

function plainSegments(content: string): MobileSyntaxSegment[] {
  return [{ kind: 'plain', text: content }]
}
