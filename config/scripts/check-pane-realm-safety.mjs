#!/usr/bin/env node
/** Reject opener-realm DOM reads from every pane-reachable local module. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const STATIC_IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"\n]+)['"]/g
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g
const STATIC_REQUIRE_PATTERN = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g

const SCOPES = [
  'src/renderer/src/components/terminal-pane',
  'src/renderer/src/components/tab-group',
  'src/renderer/src/components/tab-bar',
  'src/renderer/src/components/floating-terminal',
  'src/renderer/src/lib/pane-manager'
]
const PANE_REACHABLE_ENTRY_FILES = [
  'src/renderer/src/components/Terminal.tsx',
  'src/renderer/src/components/CodexRestartChip.tsx',
  'src/renderer/src/app-shell/app-command-handlers.ts',
  'src/renderer/src/app-shell/use-global-keybindings.ts',
  'src/renderer/src/hooks/usePrimarySelectionPaste.ts',
  'src/renderer/src/lib/editable-target.ts',
  'src/renderer/src/lib/focus-terminal-tab-surface.ts',
  'src/renderer/src/lib/primary-selection-capture.ts',
  'src/renderer/src/lib/primary-selection-paste.ts'
]
const PANE_GRAPH_SOURCE_ROOTS = ['src/renderer/src', 'src/shared']
// Terminal-only detached groups never render these exact main-document surfaces.
const MAIN_DOCUMENT_ONLY_SOURCE_FILES = [
  'src/renderer/src/app-shell/use-floating-workspace-panel.ts',
  'src/renderer/src/components/browser-pane/BrowserAddressBar.tsx',
  'src/renderer/src/components/browser-pane/BrowserPane.tsx',
  'src/renderer/src/components/browser-pane/markup/useMarkupKeyboardShortcuts.ts',
  'src/renderer/src/components/contextual-tours/ContextualTourOverlay.tsx',
  'src/renderer/src/components/contextual-tours/ContextualTourOverlaySurface.tsx',
  'src/renderer/src/components/contextual-tours/contextual-tour-gate.ts',
  'src/renderer/src/components/editor/CombinedDiffViewer.tsx',
  'src/renderer/src/components/editor/IpynbViewer.tsx',
  'src/renderer/src/components/editor/MarkdownPreview.tsx',
  'src/renderer/src/components/editor/NotesSendMenu.tsx',
  'src/renderer/src/components/editor/RichMarkdownEditorSurface.tsx',
  'src/renderer/src/components/editor/RichMarkdownLinkBubble.tsx',
  'src/renderer/src/components/editor/RichMarkdownReviewNoteLayer.tsx',
  'src/renderer/src/components/editor/image-viewer-dom-zoom.ts',
  'src/renderer/src/components/editor/markdown-preview-annotation-shortcut.ts',
  'src/renderer/src/components/editor/markdown-preview-search.ts',
  'src/renderer/src/components/editor/rich-markdown-auto-focus.ts',
  'src/renderer/src/components/editor/rich-markdown-visual-line.ts',
  'src/renderer/src/components/editor/use-rich-markdown-table-context-menu.ts',
  'src/renderer/src/components/editor/use-rich-markdown-table-control-target.ts',
  'src/renderer/src/components/editor/useMarkdownPreviewShortcut.ts',
  'src/renderer/src/components/editor/usePreserveSectionDuringExternalEdit.ts',
  'src/renderer/src/components/editor/useRichMarkdownPendingFocus.ts',
  'src/renderer/src/components/editor/useRichMarkdownSearch.ts',
  'src/renderer/src/components/native-chat/use-native-chat-paste-bridge.ts',
  'src/renderer/src/components/sidebar/AddRepoStartSteps.tsx',
  'src/renderer/src/components/sidebar/WorkspaceKanbanDrawer.tsx',
  'src/renderer/src/components/sidebar/WorkspaceKanbanLaneGrid.tsx',
  'src/renderer/src/components/sidebar/WorkspaceKanbanSettingsMenu.tsx',
  'src/renderer/src/components/sidebar/WorktreeCardAgents.tsx',
  'src/renderer/src/components/sidebar/WorktreeContextMenu.tsx',
  'src/renderer/src/components/sidebar/host-header-drag-dom.ts',
  'src/renderer/src/components/sidebar/project-group-header-drag-contract.ts',
  'src/renderer/src/components/sidebar/project-header-drag-contract.ts',
  'src/renderer/src/components/sidebar/use-sidebar-feedback-environment-prefill.ts',
  'src/renderer/src/components/sidebar/use-workspace-kanban-area-selection.ts',
  'src/renderer/src/components/sidebar/use-workspace-kanban-card-pointer-drag.ts',
  'src/renderer/src/components/sidebar/use-workspace-kanban-outside-dismiss.ts',
  'src/renderer/src/components/sidebar/use-workspace-kanban-shift-wheel-scroll.ts',
  'src/renderer/src/components/sidebar/use-workspace-status-drop.ts',
  'src/renderer/src/components/sidebar/use-worktree-card-activation-actions.ts',
  'src/renderer/src/components/sidebar/useWorkspaceBoardPanel.ts',
  'src/renderer/src/components/sidebar/workspace-kanban-area-selection-dom.ts',
  'src/renderer/src/components/sidebar/workspace-kanban-card-pointer-drag-dom.ts',
  'src/renderer/src/components/sidebar/workspace-kanban-card-pointer-drag-start.ts',
  'src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx',
  'src/renderer/src/components/sidebar/worktree-card-dom-events.ts',
  'src/renderer/src/components/sidebar/worktree-list/drag/status-target.ts',
  'src/renderer/src/components/sidebar/worktree-list/drag/use-status-row-drag.ts',
  'src/renderer/src/components/sidebar/worktree-list/navigation/use-keyboard.ts',
  'src/renderer/src/components/sidebar/worktree-list/navigation/use-selection.ts',
  'src/renderer/src/components/sidebar/worktree-sidebar-pointer-drag-dom.ts'
]

const PATTERNS = [
  {
    name: 'bare instanceof against a DOM constructor',
    regex:
      /instanceof (HTMLElement|HTMLTextAreaElement|HTMLInputElement|HTMLAnchorElement|HTMLCanvasElement|HTMLDivElement|Element|Node|InputEvent|CompositionEvent|KeyboardEvent|MouseEvent|DragEvent|FocusEvent|PointerEvent)\b/,
    fix: 'use realm-safe predicates from @/lib/cross-realm-dom-predicates'
  },
  {
    name: 'document.activeElement',
    regex: /document\.activeElement/,
    fix: 'use activeElementFor(node) from @/lib/cross-realm-dom-predicates'
  }
]

function toProjectPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function sourceFiles(root, directory) {
  const absoluteDirectory = path.resolve(root, directory)
  if (!existsSync(absoluteDirectory)) {
    return []
  }
  const files = []
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const file = path.join(absoluteDirectory, entry.name)
    if (entry.isDirectory()) {
      files.push(...sourceFiles(root, file))
    } else if (SOURCE_FILE_PATTERN.test(entry.name) && !TEST_FILE_PATTERN.test(entry.name)) {
      files.push(file)
    }
  }
  return files
}

function importSpecifiers(source) {
  return [
    ...source.matchAll(STATIC_IMPORT_PATTERN),
    ...source.matchAll(DYNAMIC_IMPORT_PATTERN),
    ...source.matchAll(STATIC_REQUIRE_PATTERN)
  ].map((match) => match[1])
}

function resolveLocalImport(root, importer, rawSpecifier) {
  const specifier = rawSpecifier.split(/[?#]/, 1)[0]
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) {
    return null
  }
  const unresolved = specifier.startsWith('@/')
    ? path.resolve(root, 'src/renderer/src', specifier.slice(2))
    : path.resolve(path.dirname(importer), specifier)
  const candidates = [
    unresolved,
    ...SOURCE_EXTENSIONS.map((extension) => `${unresolved}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(unresolved, `index${extension}`))
  ]
  for (const candidate of candidates) {
    if (
      existsSync(candidate) &&
      statSync(candidate).isFile() &&
      SOURCE_FILE_PATTERN.test(candidate) &&
      !TEST_FILE_PATTERN.test(candidate)
    ) {
      return candidate
    }
  }
  return null
}

export function collectPaneReachableFiles(
  root = process.cwd(),
  {
    scopes = SCOPES,
    entries = PANE_REACHABLE_ENTRY_FILES,
    sourceRoots = PANE_GRAPH_SOURCE_ROOTS
  } = {}
) {
  const files = new Set(scopes.flatMap((scope) => sourceFiles(root, scope)))
  const graphRoots = sourceRoots.map((sourceRoot) => path.resolve(root, sourceRoot))
  const pending = entries.map((entry) => path.resolve(root, entry)).filter(existsSync)
  const visited = new Set()
  while (pending.length > 0) {
    const file = pending.pop()
    if (visited.has(file)) {
      continue
    }
    visited.add(file)
    files.add(file)
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      const imported = resolveLocalImport(root, file, specifier)
      if (
        imported &&
        graphRoots.some(
          (graphRoot) => imported === graphRoot || imported.startsWith(`${graphRoot}${path.sep}`)
        ) &&
        !visited.has(imported)
      ) {
        pending.push(imported)
      }
    }
  }
  return [...files].sort()
}

export function findPaneRealmSafetyHits(root = process.cwd(), options) {
  const files = collectPaneReachableFiles(root, options)
  const mainDocumentOnlyFiles = new Set(
    MAIN_DOCUMENT_ONLY_SOURCE_FILES.map((sourceFile) => path.resolve(root, sourceFile))
  )
  return PATTERNS.map((pattern) => {
    const hits = []
    for (const file of files) {
      if (mainDocumentOnlyFiles.has(file)) {
        continue
      }
      for (const [index, line] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
        const code = line.trim()
        if (pattern.regex.test(line) && !code.startsWith('//') && !code.startsWith('*')) {
          hits.push(`${toProjectPath(root, file)}:${index + 1}:${code}`)
        }
      }
    }
    return { ...pattern, hits }
  }).filter((result) => result.hits.length > 0)
}

export function main(root = process.cwd()) {
  const failures = findPaneRealmSafetyHits(root)
  for (const failure of failures) {
    console.error(`\n${failure.name} — ${failure.hits.length} site(s). Fix: ${failure.fix}`)
    for (const hit of failure.hits) {
      console.error(`  ${hit}`)
    }
  }
  if (failures.length > 0) {
    console.error(
      '\nPane code must stay realm-safe; see config/scripts/check-pane-realm-safety.mjs'
    )
    return 1
  }
  console.log('pane realm safety: ok')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main()
}
