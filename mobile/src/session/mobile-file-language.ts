import { detectLanguage } from '../../../src/shared/editor-language/editor-language-detect'

export function detectMobileFileLanguage(filePath: string, preferredLanguage?: string): string {
  const normalizedPreferred = preferredLanguage?.trim().toLowerCase()
  if (normalizedPreferred && normalizedPreferred !== 'plaintext') {
    return normalizedPreferred
  }
  return detectLanguage(filePath)
}
