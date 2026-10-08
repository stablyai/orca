/**
 * Ratchet: outside `persistence/terminal-topology/`, only the files listed here may reference a
 * named layout writer. Blind to in-place mutation of the object `getWorkspaceSession` returns.
 */
import { resolve } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'
import { scanSourceTree } from '../../../shared/source-scan/source-tree-scan'

const MAIN_ROOT = resolve(__dirname, '../..')
const BOUNDARY_DIR = 'persistence/terminal-topology/'

/**
 * Files (relative to `src/main`) outside the boundary referencing each writer; each routing change
 * deletes its own rows. Not listed: lifecycle writers (repo/worktree removal, identity rekey) and
 * SSH lease marks that drop a dead PTY's binding; they delete or rekey layout, never choose it.
 */
const ALLOWED_REFERENCES: Record<string, readonly string[]> = {
  terminalSurfaceCloseMutation: [],
  persistPtyBinding: [
    'ipc/pty/ipc/spawn-commit-persist.ts',
    'ipc/pty/pane/stable-owner.ts',
    'ipc/pty/runtime/spawn-commit.ts',
    'ssh/ssh-relay-session.ts'
  ],
  // Several runtime files only check it exists, then write through setWorkspaceSessionForWorktree.
  setWorkspaceSession: [
    'ipc/pty/pane/stable-owner.ts',
    'ipc/session.ts',
    // Store-internal: patchWorkspaceSession -> setWorkspaceSession.
    'persistence/loading-store/session-snapshot-operations.ts',
    // Test support: seeds sessions for the acknowledged-tab retirement audit.
    'runtime/acknowledged-terminal-tab-retirement-fixture.ts',
    'runtime/client-hosted-browser-page-persistence.ts',
    'runtime/orca-runtime-adopt-terminal-orphans-from-inventory.ts',
    'runtime/orca-runtime-apply-mobile-session-tab-navigation.ts',
    'runtime/orca-runtime-attach-window.ts',
    'runtime/orca-runtime-build-headless-mobile-session-browser-tabs.ts',
    'runtime/orca-runtime-move-headless-mobile-session-tab.ts',
    'runtime/orca-runtime-persist-headless-session-tab-props.ts',
    'runtime/orca-runtime-persist-headless-terminal-title.ts',
    'runtime/orca-runtime-persist-terminal-surface-retirements.ts',
    'runtime/orca-runtime-pty-foreground-process-reads.ts',
    'runtime/orca-runtime-stop-terminals-for-worktree.ts',
    'runtime/runtime-legacy-worker-terminal-recovery-persistence.ts',
    'runtime/runtime-workspace-session-controller.ts'
  ],
  // The partition sinks under setWorkspaceSession and stageWorkspaceSessionBeforeUnload.
  setLocalWorkspaceSession: ['persistence/loading-store/session-snapshot-operations.ts'],
  setHostWorkspaceSession: ['persistence/loading-store/session-snapshot-operations.ts'],
  // The runtime's session controller, reachable from every OrcaRuntime mixin.
  setForWorktree: ['runtime/orca-runtime-get-runtime-id.ts'],
  patchWorkspaceSession: ['ipc/session.ts'],
  stageWorkspaceSessionBeforeUnload: ['ipc/renderer-shutdown-checkpoint.ts'],
  setWorkspaceSessionForWorktree: [
    // Host-owned editor tabs (and their group edits) while no window is attached.
    'runtime/host-editor-tab-publication.ts',
    'runtime/orca-runtime-adopt-terminal-orphans-from-inventory.ts',
    'runtime/orca-runtime-apply-mobile-session-tab-navigation.ts',
    'runtime/orca-runtime-build-headless-mobile-session-browser-tabs.ts',
    'runtime/orca-runtime-move-headless-mobile-session-tab.ts',
    'runtime/orca-runtime-persist-headless-session-tab-props.ts',
    'runtime/orca-runtime-persist-headless-terminal-title.ts',
    'runtime/orca-runtime-pty-foreground-process-reads.ts'
  ]
}

/** A writer's own definition (a function or class member), as opposed to any other mention. */
function isDefinitionName(node: ts.Node): boolean {
  const parent = node.parent
  return (
    (ts.isFunctionDeclaration(parent) ||
      (ts.isClassElement(parent) && ts.isClassLike(parent.parent))) &&
    parent.name === node
  )
}

function isTypeOnlyImportOrExport(node: ts.Node): boolean {
  return (
    ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && node.isTypeOnly) ||
    (ts.isImportClause(node) && node.isTypeOnly) ||
    (ts.isExportDeclaration(node) && node.isTypeOnly)
  )
}

/** Any name or string literal except the writer's own definition; types are skipped. */
function referencedName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
    return isDefinitionName(node) ? undefined : node.text
  }
  return undefined
}

function referencingFilesByWriter(): Map<string, Set<string>> {
  const writers = Object.keys(ALLOWED_REFERENCES)
  const references = new Map(writers.map((writer) => [writer, new Set<string>()]))
  for (const file of scanSourceTree(MAIN_ROOT)) {
    // Why prefilter: parsing every main-process file would dominate the test's budget. A matched
    // name appears verbatim in the text unless it is spelled with an escape.
    if (
      file.relativePath.startsWith(BOUNDARY_DIR) ||
      (!file.source.includes('\\') && !writers.some((writer) => file.source.includes(writer)))
    ) {
      continue
    }
    const source = ts.createSourceFile(file.relativePath, file.source, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      // Why: ExpressionWithTypeArguments is a type node but also holds `extends f(x)` and `x<T>`.
      const typeOnly =
        (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) ||
        ts.isInterfaceDeclaration(node) ||
        isTypeOnlyImportOrExport(node)
      if (typeOnly) {
        return
      }
      const name = referencedName(node)
      if (name !== undefined) {
        references.get(name)?.add(file.relativePath)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return references
}

describe('terminal topology boundary ratchet', () => {
  const references = referencingFilesByWriter()

  for (const [writer, allowed] of Object.entries(ALLOWED_REFERENCES)) {
    it(`only the boundary and listed files reference ${writer}`, () => {
      expect(references.get(writer)).toEqual(new Set(allowed))
    })
  }
})
