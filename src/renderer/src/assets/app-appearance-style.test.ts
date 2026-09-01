import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainCss = readFileSync(new URL('./main.css', import.meta.url), 'utf8')
const richMarkdownCss = readFileSync(new URL('./rich-markdown-editor.css', import.meta.url), 'utf8')
const popoutSource = readFileSync(new URL('../popout.tsx', import.meta.url), 'utf8')
const pdfViewerSource = readFileSync(
  new URL('../components/editor/PdfViewer.tsx', import.meta.url),
  'utf8'
)
const markdownSurfaceSource = readFileSync(
  new URL('../components/editor/EditorMarkdownFileSurface.tsx', import.meta.url),
  'utf8'
)
const editorSchemeSources = [
  '../components/editor/ConflictComponents.tsx',
  '../components/editor/DiffSectionHeader.tsx',
  '../components/editor/ExternalFileChangeBanner.tsx',
  '../components/editor/NotesSendMenu.tsx',
  '../components/editor/combined-diff/review-controls/combined-diff-toolbar.tsx'
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
const themePreviewSources = [
  '../components/settings/use-settings-navigation-model.ts',
  '../components/onboarding/use-onboarding-flow.ts'
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
const editorPortalSources = [
  '../components/editor/RichMarkdownToolbar.tsx',
  '../components/editor/RichMarkdownTableControls.tsx'
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
const findOverlaySources = [
  '../components/TerminalSearch.tsx',
  '../components/browser-pane/assemble-chrome/BrowserFind.tsx',
  '../components/editor/PdfFind.tsx'
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
const portalPrimitiveSources = [
  '../components/ui/dropdown-menu.tsx',
  '../components/ui/context-menu.tsx',
  '../components/ui/popover.tsx',
  '../components/ui/select.tsx',
  '../components/ui/hover-card.tsx',
  '../components/ui/dialog.tsx',
  '../components/ui/sheet.tsx',
  '../components/ui/command.tsx'
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
const selectedRowSources = [
  '../components/activity/activity-thread-row.tsx',
  '../components/sidebar/SidebarFilter.tsx',
  '../components/sidebar/SidebarProjectFilterPanel.tsx'
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
const customMenuSources = [
  '../components/SelectedTextCopyMenu.tsx',
  '../components/browser-pane/assemble-chrome/browser-page-context-menu.tsx',
  '../components/browser-pane/stream-remote/remote-browser-page-context-menu.tsx'
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
const customChromeSources = [
  '../components/tab-bar/TabBarCreateEntryRow.tsx',
  '../components/floating-terminal/FloatingTerminalPanelSurface.tsx',
  '../components/right-sidebar/file-explorer-row-context-menu.tsx',
  '../components/browser-pane/annotate/browser-page-grab-toast.tsx'
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

describe('custom app appearance styles', () => {
  it('lets floating surfaces inherit semantic tokens without forced overrides', () => {
    expect(mainCss).not.toMatch(
      /data-app-appearance[^}]*data-slot=['"](?:dialog|popover|dropdown|context|select|hover-card|command)/
    )
    expect(mainCss).not.toMatch(/data-app-appearance[^{}]*\{[^}]*!important/)
  })

  it('isolates hosted editors from an opposite App Appearance scheme', () => {
    expect(mainCss).toMatch(
      /data-app-appearance[^}]*:is\([^)]*\.editor-content-pane[^)]*\.markdown-preview-shell[^)]*\.rich-markdown-editor-layout[^)]*\.rich-markdown-link-bubble[^)]*\.rich-markdown-editor-portal[^)]*\)[^{]*\{[^}]*--secondary: var\(--orca-editor-base-secondary\);[^}]*--destructive: var\(--orca-editor-base-destructive\);[^}]*--status-success: var\(--orca-editor-base-status-success\);[^}]*--annotation-highlight: var\(--orca-editor-base-annotation-highlight\);[^}]*--markdown-search-match: var\(--orca-editor-base-markdown-search-match\);[^}]*--editor-surface: var\(--orca-editor-base-editor-surface\)/s
    )
    expect(richMarkdownCss).not.toContain('.dark .rich-markdown')
    expect(richMarkdownCss).toContain('.orca-editor-dark .rich-markdown')
    expect(mainCss).toContain('@custom-variant editor-dark')
    expect(mainCss).not.toMatch(/\.dark \.orca-diff-comment/)
    expect(mainCss).toContain('.orca-editor-dark .orca-diff-comment')
    expect(pdfViewerSource).toContain('editor-dark:[--pdf-viewer-bg:#18181b]')
    expect(markdownSurfaceSource).toContain('editor-dark:text-amber-100')
    for (const source of editorSchemeSources) {
      expect(source).not.toMatch(/(?:^|[\s'"`])dark:/)
      expect(source).toContain('editor-dark:')
    }
  })

  it('keeps stable theme bases and plugin security token ownership', () => {
    expect(mainCss.match(/--app-appearance-base-background:/g)).toHaveLength(2)
    expect(mainCss.match(/--app-appearance-base-foreground:/g)).toHaveLength(2)
    expect(mainCss).toMatch(
      /\.plugin-security-chrome\s*\{[^}]*--background: var\(--orca-security-background\);[^}]*--popover: var\(--orca-security-popover\);/s
    )
  })

  it('uses semantic surfaces for portaled primitive defaults', () => {
    for (const source of portalPrimitiveSources) {
      expect(source).not.toMatch(/bg-\[rgba\((?:255|23|0),/)
      expect(source).not.toContain('border-black/14')
      expect(source).not.toContain('dark:border-white/14')
    }
  })

  it('uses semantic surfaces for custom menus and floating chrome', () => {
    for (const source of customMenuSources) {
      expect(source).toContain('border-border')
      expect(source).toContain('bg-popover')
      expect(source).toContain('text-popover-foreground')
    }
    for (const source of [...customMenuSources, ...customChromeSources]) {
      expect(source).not.toContain('border-black/14')
      expect(source).not.toContain('dark:border-white/14')
      expect(source).not.toMatch(/bg-\[rgba\((?:255|23|0),/)
    }
  })

  it('uses semantic App Appearance tokens for first-party find overlays', () => {
    for (const source of findOverlaySources) {
      expect(source).toContain('border-border')
      expect(source).toContain('bg-popover/95')
      expect(source).toContain('text-popover-foreground')
      expect(source).not.toContain('zinc-')
    }
  })

  it('uses semantic accent tokens for first-party selected rows', () => {
    for (const source of selectedRowSources) {
      expect(source).toContain('bg-accent')
      expect(source).not.toMatch(/(?:selected=true|selectedAgentId)[^'"\n]*(?:bg-black|bg-white)/)
    }
    for (const source of selectedRowSources.slice(1)) {
      expect(source).toContain('jump-palette-item')
    }
  })

  it('reapplies complete App Appearance snapshots during theme previews', () => {
    for (const source of themePreviewSources) {
      expect(source).toContain('applyDocumentAppearance')
      expect(source).not.toContain('applyDocumentTheme')
    }
  })

  it('keeps editor-owned dropdown portals on editor tokens', () => {
    expect(mainCss).toContain('.rich-markdown-editor-portal')
    for (const source of editorPortalSources) {
      expect(source).toContain('rich-markdown-editor-portal')
    }
  })

  it('applies the shared document helper in the dashboard popout', () => {
    expect(popoutSource).toContain('applyDocumentAppearance')
    expect(popoutSource).not.toContain('applyDocumentTheme')
  })
})
