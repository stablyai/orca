import { detectLanguage } from '../../../../src/shared/editor-language/editor-language-detect'

export function detectMobileFileLanguage(filePath: string, preferredLanguage?: string): string {
  const normalizedPreferred = preferredLanguage?.trim().toLowerCase()
  if (normalizedPreferred && normalizedPreferred !== 'plaintext') {
    return normalizedPreferred
  }
  const path = filePath.toLowerCase()
  if (path.endsWith('.bsl') || path.endsWith('.os')) {
    return '1c'
  }
  return detectLanguage(filePath)
}
