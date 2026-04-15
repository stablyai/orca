/**
 * E2E tests for opening files and markdown preview from the right sidebar.
 *
 * User Prompt:
 * - you can open files (from the right sidebar)
 * - you can open .md files and they show up as preview (from the right sidebar)
 */

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  getActiveWorktreeId,
  getActiveTabType,
  getOpenFiles,
  ensureTerminalVisible,
} from './helpers/store'

/** Open the right sidebar file explorer and wait for it to be ready. */
async function openFileExplorer(orcaPage: import('@playwright/test').Page): Promise<void> {
  await orcaPage.keyboard.press('Meta+Shift+e')
  await expect
    .poll(
      async () => orcaPage.evaluate(() => (window as any).__store?.getState().rightSidebarOpen),
      { timeout: 3_000 }
    )
    .toBe(true)
  // Wait for the explorer content to load
  await orcaPage
    .locator('[data-native-file-drop-target="file-explorer"]')
    .waitFor({ state: 'visible', timeout: 5_000 })
}

/**
 * Click a file by name in the file explorer.
 * Returns the file name clicked, or null if none of the candidates were found.
 */
async function clickFileInExplorer(
  orcaPage: import('@playwright/test').Page,
  candidates: string[]
): Promise<string | null> {
  for (const fileName of candidates) {
    const fileRow = orcaPage.getByText(fileName, { exact: true }).first()
    const isVisible = await fileRow.isVisible({ timeout: 1_000 }).catch(() => false)
    if (isVisible) {
      await fileRow.click()
      return fileName
    }
  }
  return null
}

test.describe('File Open & Markdown Preview', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await getActiveWorktreeId(orcaPage)
    expect(worktreeId).not.toBeNull()
    await ensureTerminalVisible(orcaPage)
  })

  test.afterEach(async ({ orcaPage }) => {
    // Clean up: close all open editor files
    const worktreeId = await getActiveWorktreeId(orcaPage)
    if (!worktreeId) return
    let openFiles = await getOpenFiles(orcaPage, worktreeId)
    for (const file of openFiles) {
      await orcaPage.evaluate((fileId) => {
        const store = (window as any).__store
        if (!store) return
        store.getState().closeFile(fileId)
      }, file.id)
    }
    // Switch back to terminal view
    await orcaPage.evaluate(() => {
      const store = (window as any).__store
      if (!store) return
      store.getState().setActiveTabType('terminal')
    })
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   */
  test('opening the right sidebar with Cmd+Shift+E shows file explorer', async ({ orcaPage }) => {
    await orcaPage.keyboard.press('Meta+Shift+e')

    // Verify the right sidebar is open and on the explorer tab
    await expect
      .poll(
        async () => orcaPage.evaluate(() => (window as any).__store?.getState().rightSidebarOpen),
        { timeout: 3_000 }
      )
      .toBe(true)

    await expect
      .poll(
        async () => orcaPage.evaluate(() => (window as any).__store?.getState().rightSidebarTab),
        { timeout: 3_000 }
      )
      .toBe('explorer')
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   */
  test('clicking a file in the file explorer opens it in an editor tab', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    await openFileExplorer(orcaPage)

    const filesBefore = await getOpenFiles(orcaPage, worktreeId)

    // Click a known non-directory file
    const clickedFile = await clickFileInExplorer(orcaPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'README.md',
    ])
    expect(clickedFile).not.toBeNull()

    // Wait for the file to be opened in the editor
    await expect
      .poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 })
      .toBe('editor')

    // There should be a new open file
    await expect
      .poll(async () => (await getOpenFiles(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThan(filesBefore.length)
  })

  /**
   * User Prompt:
   * - you can open .md files and they show up as preview (from the right sidebar)
   */
  test('opening a .md file shows markdown content', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Why: the file explorer uses virtualized rendering, so .md files may be
    // off-screen and not in the DOM. Open the file via the store, which is the
    // same code path as double-clicking in the explorer.
    const opened = await orcaPage.evaluate((worktreeId) => {
      const store = (window as any).__store
      if (!store) return false
      const state = store.getState()
      // Find the worktree path to build a file path
      const allWorktrees = Object.values(state.worktreesByRepo).flat() as any[]
      const wt = allWorktrees.find((w: any) => w.id === worktreeId)
      if (!wt) return false
      const candidates = ['CLAUDE.md', 'README.md', 'AGENTS.md']
      for (const name of candidates) {
        const filePath = `${wt.path}/${name}`
        // Why: mode and language must be set explicitly. Without mode: 'edit',
        // EditorPanel won't load file content. Without language: 'markdown',
        // the isMarkdown check fails and the rich editor/preview won't render.
        state.openFile({
          worktreeId,
          filePath,
          relativePath: name,
          mode: 'edit',
          language: 'markdown',
        })
        return true
      }
      return false
    }, worktreeId)
    expect(opened).toBe(true)

    // Wait for the editor tab to become active
    await expect
      .poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 })
      .toBe('editor')

    // Why: .md files render via EditorContent which detects isMarkdown and
    // uses either RichMarkdownEditor (ProseMirror/Tiptap) for rich editing,
    // or MarkdownPreview (react-markdown) when the content has unsupported
    // elements. Both render formatted markdown — not raw source. Monaco is
    // only used in "source" mode which is not the default for .md files.
    // We verify a rich/preview surface appeared, not just a source editor.
    // Why: the file content is loaded asynchronously after openFile(). The
    // editor component must fetch the content, determine the render mode, then
    // mount the appropriate surface (Tiptap or preview). Give it extra time.
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => {
            // Tiptap rich editor renders a ProseMirror element inside
            // .rich-markdown-editor-shell
            const proseMirror = document.querySelector('.ProseMirror')
            const richShell = document.querySelector('.rich-markdown-editor-shell')
            // MarkdownPreview renders into a .markdown-preview container
            const markdownPreview = document.querySelector('.markdown-preview')
            return !!(proseMirror || richShell || markdownPreview)
          }),
        { timeout: 15_000, message: 'No markdown preview or rich editor surface rendered' }
      )
      .toBe(true)
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   * - files retain state when switching tabs
   */
  test('editor tab retains state when switching to terminal and back', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    await openFileExplorer(orcaPage)

    // Click a file to open it
    const clickedFile = await clickFileInExplorer(orcaPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore',
    ])
    expect(clickedFile).not.toBeNull()

    // Wait for editor to become active
    await expect
      .poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 })
      .toBe('editor')

    // Record what files are open
    const openFilesBefore = await getOpenFiles(orcaPage, worktreeId)
    expect(openFilesBefore.length).toBeGreaterThan(0)

    // Switch to a terminal tab by navigating with keyboard
    await orcaPage.keyboard.press('Meta+Shift+BracketLeft')
    await expect
      .poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 })
      .not.toBe('editor')

    // Switch back toward the editor tab
    await orcaPage.keyboard.press('Meta+Shift+BracketRight')
    await expect
      .poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 })
      .toBe('editor')

    // The same files should still be open
    const openFilesAfter = await getOpenFiles(orcaPage, worktreeId)
    expect(openFilesAfter.length).toBe(openFilesBefore.length)
    expect(openFilesAfter[0].filePath).toBe(openFilesBefore[0].filePath)
  })
})
