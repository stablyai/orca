import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// RATCHET — this list may only SHRINK. Each entry still imports the frozen dark `colors`
// alias and therefore will not follow the app theme. Delete entries as you convert;
// never add one. Empty list == migration complete.
const UNTHEMED_COLOR_IMPORTERS: readonly string[] = [
  'src/components/CodexResetCreditAction.tsx',
  'app/h/[hostId]/tasks.tsx',
  'src/components/MobilePRSidebar.tsx',
  'src/components/MobilePrBasePicker.tsx',
  'src/components/pr-sidebar/CommentMarkdown.tsx',
  'src/components/pr-sidebar/MermaidDiagram.tsx',
  'src/components/pr-sidebar/MobileLinkPrForm.tsx',
  'src/components/pr-sidebar/MobilePrComposeForm.tsx',
  'src/components/pr-sidebar/MobilePrViewPanel.tsx',
  'src/components/pr-sidebar/PRActionsSection.tsx',
  'src/components/pr-sidebar/PRCheckDetail.tsx',
  'src/components/pr-sidebar/PRChecksSection.tsx',
  'src/components/pr-sidebar/PRCommentCard.tsx',
  'src/components/pr-sidebar/PRCommentComposer.tsx',
  'src/components/pr-sidebar/PRCommentsSection.tsx',
  'src/components/pr-sidebar/PRConflictingFilesSection.tsx',
  'src/components/pr-sidebar/PRReviewersSection.tsx',
  'src/components/pr-sidebar/PRSidebarHeader.tsx',
  'src/components/pr-sidebar/PrSidebarCreateEmptyState.tsx',
  'src/components/pr-sidebar/ReviewerPickerDrawer.tsx',
  'src/components/pr-sidebar/mobile-pr-compose-form-styles.ts',
  'src/components/pr-sidebar/mobile-pr-sidebar-styles.ts',
  'src/components/pr-sidebar/pr-actions-styles.ts',
  'src/components/pr-sidebar/pr-ai-triage-styles.ts',
  'src/components/pr-sidebar/pr-comment-composer-styles.ts',
  'src/components/pr-sidebar/pr-comments-styles.ts',
  'src/components/pr-sidebar/pr-conflict-styles.ts',
  'src/components/pr-sidebar/pr-create-empty-state-styles.ts',
  'src/components/pr-sidebar/pr-sidebar-status-color.ts',
  'src/files/MobileFileExplorerPanel.tsx',
  'src/files/MobileFileMarkdownPreview.tsx',
  'src/files/MobileFilePreviewBody.tsx',
  'src/files/MobileFilePreviewScreen.tsx',
  'src/files/mobile-file-explorer-row.tsx',
  'src/files/mobile-file-explorer-styles.ts',
  'src/files/mobile-file-preview-styles.ts',
  'src/source-control/MobileBranchDiffPreviewDrawer.tsx',
  'src/source-control/MobileCommitFailurePanel.tsx',
  'src/source-control/MobileGitHistoryList.tsx',
  'src/source-control/MobileSourceControlBranchCard.tsx',
  'src/source-control/MobileSourceControlContent.tsx',
  'src/source-control/MobileSourceControlCreatePrEntry.tsx',
  'src/source-control/MobileSourceControlFileRows.tsx',
  'src/source-control/MobileSourceControlHeader.tsx',
  'src/source-control/MobileSourceControlPanel.tsx',
  'src/source-control/MobileSourceControlPrChip.tsx',
  'src/source-control/mobile-source-control-diff-styles.ts',
  'src/source-control/mobile-source-control-hub-styles.ts',
  'src/source-control/mobile-source-control-list-styles.ts',
  'src/source-control/mobile-source-control-screen-state.ts',
  'src/source-control/mobile-source-control-styles.ts',
  'src/terminal/terminal-webview-frame-styles.ts',
  'src/terminal/terminal-webview-html.ts',
  'src/terminal/terminal-webview-theme-injected.ts'
]

const MOBILE_ROOT = path.resolve(__dirname, '../..')
// Matches any relative path ending in mobile-theme (…/theme/mobile-theme or ./mobile-theme).
const BARE_COLORS_IMPORT = /import\s*\{[^}]*\bcolors\b[^}]*\}\s*from\s*['"][^'"]*mobile-theme['"]/
const INLINE_THEMED_STYLES = /useThemedStyles\s*\(\s*(?:\([^)]*\)|[$A-Z_a-z][$\w]*)\s*=>/

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSourceFiles(full, out)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      continue
    }
    out.push(full)
  }
  return out
}

function listBareColorsImporters(): string[] {
  const roots = ['app', 'src'].map((segment) => path.join(MOBILE_ROOT, segment))
  const files = roots.flatMap((root) => walkSourceFiles(root))
  return files
    .filter((file) => BARE_COLORS_IMPORT.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(MOBILE_ROOT, file).split(path.sep).join('/'))
    .sort()
}

describe('unthemed color import ratchet', () => {
  it('lists every bare `colors` importer; the baseline may only shrink', () => {
    const actual = listBareColorsImporters()
    const unexpected = actual.filter((p) => !UNTHEMED_COLOR_IMPORTERS.includes(p))
    const convertedButStillListed = UNTHEMED_COLOR_IMPORTERS.filter((p) => !actual.includes(p))
    // Why toEqual([]): failures print the exact offending paths.
    expect(unexpected).toEqual([])
    expect(convertedButStillListed).toEqual([])
  })

  it('forbids inline useThemedStyles(() => …) factories (fresh cache key every render)', () => {
    const roots = ['app', 'src'].map((segment) => path.join(MOBILE_ROOT, segment))
    const offenders = roots
      .flatMap((root) => walkSourceFiles(root))
      .filter((file) => INLINE_THEMED_STYLES.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(MOBILE_ROOT, file).split(path.sep).join('/'))
      .sort()
    expect(offenders).toEqual([])
  })
})
