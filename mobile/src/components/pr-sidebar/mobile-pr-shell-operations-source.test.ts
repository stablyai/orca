import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sharedPrSources = [
  '../MobilePRSidebar.tsx',
  './CommentMarkdown.tsx',
  './MobileLinkPrForm.tsx',
  './PRChecksSection.tsx',
  './PRCommentCard.tsx',
  './PRConflictingFilesSection.tsx',
  './PRSidebarHeader.tsx',
  './PrSidebarCreateEmptyState.tsx',
  '../../session/use-mobile-pr-ai-triage.ts',
  '../../session/use-mobile-pr-comment-actions.ts',
  '../../session/use-mobile-pr-title-action.ts'
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

const nativeOperations = readFileSync(
  new URL('../../platform/native-mobile-pr-shell-operations.ts', import.meta.url),
  'utf8'
)
const context = readFileSync(
  new URL('../../platform/mobile-pr-shell-operations.tsx', import.meta.url),
  'utf8'
)

describe('mobile PR shell operations boundary', () => {
  it('keeps native APIs out of the React Native Web presentation', () => {
    for (const source of sharedPrSources) {
      expect(source).not.toContain('expo-clipboard')
      expect(source).not.toContain("from '../platform/haptics'")
      expect(source).not.toContain("from '../../platform/haptics'")
      expect(source).not.toMatch(/\bLinking\b/)
    }
  })

  it('isolates native implementations behind required injected operations', () => {
    expect(context).toContain('MobilePrShellOperationsContext')
    expect(context).toContain("throw new Error('Mobile PR shell operations are unavailable')")
    expect(nativeOperations).toContain("from 'expo-clipboard'")
    expect(nativeOperations).toContain("import { Linking } from 'react-native'")
  })
})
