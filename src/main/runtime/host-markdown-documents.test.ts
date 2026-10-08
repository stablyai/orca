/**
 * markdown.readTab / markdown.saveTab on a host with no desktop window: the host reads the file,
 * hashes what it returns, and saves only when the file still matches the phone's base version.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  hashMarkdownContent,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  MOBILE_MARKDOWN_READ_MAX_BYTES
} from '../../shared/mobile-markdown-document'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { getDefaultWorkspaceSession } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_REPO_ID } = await import('./orca-runtime-test-fixtures.spec')
const { createHeadlessEditorHarness, runtimeFileCommands } =
  await import('./host-editor-tabs-test-harness.spec')

async function openedMarkdown(content: string | Buffer, relativePath = 'notes.md') {
  const harness = await createHeadlessEditorHarness()
  const filePath = await harness.writeWorktreeFile(relativePath, content)
  await harness.runtime.openMobileFile(`id:${harness.worktreeId}`, relativePath)
  const [tab] = (await harness.runtime.listMobileSessionTabs(`id:${harness.worktreeId}`)).tabs
  return { ...harness, filePath, tabId: tab!.id, selector: `id:${harness.worktreeId}` }
}

describe('host Markdown documents with no desktop window', () => {
  it('reads the file with a content-hash version and an editable flag', async () => {
    const { runtime, selector, tabId, filePath } = await openedMarkdown('# Notes\n')

    const read = await runtime.readMobileMarkdownTab(selector, tabId)

    expect(read).toEqual({
      tabId,
      filePath,
      relativePath: 'notes.md',
      content: '# Notes\n',
      isDirty: false,
      version: hashMarkdownContent('# Notes\n'),
      source: 'file',
      editable: true
    })
  })

  it('saves when the base version matches and verifies the bytes on disk', async () => {
    const { runtime, selector, tabId, filePath } = await openedMarkdown('old')

    const saved = await runtime.saveMobileMarkdownTab(
      selector,
      tabId,
      hashMarkdownContent('old'),
      'new text'
    )

    expect(saved).toEqual({
      tabId,
      version: hashMarkdownContent('new text'),
      isDirty: false,
      content: 'new text'
    })
    expect(await readFile(filePath, 'utf8')).toBe('new text')
  })

  it('reports a conflict instead of overwriting a file that changed on the host', async () => {
    const { runtime, selector, tabId, filePath } = await openedMarkdown('v1')
    await writeFile(filePath, 'changed on the computer')

    await expect(
      runtime.saveMobileMarkdownTab(selector, tabId, hashMarkdownContent('v1'), 'phone edit')
    ).rejects.toThrow('conflict')
    expect(await readFile(filePath, 'utf8')).toBe('changed on the computer')
  })

  it('treats an identical re-save as success', async () => {
    const { runtime, selector, tabId } = await openedMarkdown('v1')
    await runtime.saveMobileMarkdownTab(selector, tabId, hashMarkdownContent('v1'), 'v2')

    await expect(
      runtime.saveMobileMarkdownTab(selector, tabId, hashMarkdownContent('v1'), 'v2')
    ).resolves.toMatchObject({ version: hashMarkdownContent('v2'), content: 'v2' })
  })

  it('serializes concurrent saves of one file so the second sees the first', async () => {
    const { runtime, selector, tabId, filePath } = await openedMarkdown('base')
    const base = hashMarkdownContent('base')

    const results = await Promise.allSettled([
      runtime.saveMobileMarkdownTab(selector, tabId, base, 'first'),
      runtime.saveMobileMarkdownTab(selector, tabId, base, 'second')
    ])

    expect(results[0]).toMatchObject({ status: 'fulfilled' })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('conflict') })
    expect(await readFile(filePath, 'utf8')).toBe('first')
  })

  it('releases the save lane after a failed save', async () => {
    const { runtime, selector, tabId } = await openedMarkdown('base')
    await expect(
      runtime.saveMobileMarkdownTab(selector, tabId, 'content:0:stale', 'x')
    ).rejects.toThrow('conflict')

    await expect(
      runtime.saveMobileMarkdownTab(selector, tabId, hashMarkdownContent('base'), 'ok')
    ).resolves.toMatchObject({ content: 'ok' })
  })

  it('keeps the file untouched when a write fails', async () => {
    const { runtime, selector, tabId, filePath } = await openedMarkdown('base')
    const write = vi
      .spyOn(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are protected runtime members with the shapes named here.
        runtime as never as { writeHostMarkdownFile: () => Promise<void> },
        'writeHostMarkdownFile'
      )
      .mockRejectedValueOnce(new Error('disk full'))

    await expect(
      runtime.saveMobileMarkdownTab(selector, tabId, hashMarkdownContent('base'), 'new')
    ).rejects.toThrow('disk full')
    expect(await readFile(filePath, 'utf8')).toBe('base')
    write.mockRestore()
  })

  it('aborts the write when the tab closes while the write is being authorized', async () => {
    const { runtime, selector, tabId, filePath, worktreeId, getSession, setSession } =
      await openedMarkdown('base')
    const commands = runtimeFileCommands(runtime)
    const original = commands.writeFileExplorerFile.bind(commands)
    vi.spyOn(commands, 'writeFileExplorerFile').mockImplementation(async (...args: unknown[]) => {
      // Why here: after the helper's own authorization, before its final beforeWrite check.
      const session = getSession()
      setSession({ ...session, openFilesByWorktree: { [worktreeId]: [] } })
      return original(...args)
    })

    await expect(
      runtime.saveMobileMarkdownTab(selector, tabId, hashMarkdownContent('base'), 'late')
    ).rejects.toThrow('tab_not_found')
    expect(await readFile(filePath, 'utf8')).toBe('base')
  })

  it('reads a document over the edit limit as read-only file_too_large', async () => {
    const big = 'a'.repeat(MOBILE_MARKDOWN_EDIT_MAX_BYTES + 1)
    const { runtime, selector, tabId } = await openedMarkdown(big)

    const read = await runtime.readMobileMarkdownTab(selector, tabId)

    expect(read).toMatchObject({ editable: false, readOnlyReason: 'file_too_large' })
    expect(read.truncated).toBeUndefined()
    await expect(
      runtime.saveMobileMarkdownTab(selector, tabId, read.version, 'small')
    ).rejects.toThrow('file_too_large')
  })

  it('truncates a document over the read budget at a UTF-8 boundary and never makes it editable', async () => {
    // Why a 3-byte character straddling the budget: the prefix must not split it.
    const body = `${'a'.repeat(MOBILE_MARKDOWN_READ_MAX_BYTES - 1)}€tail`
    const { runtime, selector, tabId } = await openedMarkdown(body)

    const read = await runtime.readMobileMarkdownTab(selector, tabId)

    expect(read).toMatchObject({
      truncated: true,
      byteLength: Buffer.byteLength(body),
      editable: false,
      readOnlyReason: 'file_too_large'
    })
    expect(read.content).toBe('a'.repeat(MOBILE_MARKDOWN_READ_MAX_BYTES - 1))
    expect(read.version).toBe(hashMarkdownContent(read.content))
    await expect(runtime.saveMobileMarkdownTab(selector, tabId, read.version, 'x')).rejects.toThrow(
      'file_too_large'
    )
  })

  it('refuses a binary document like the window does', async () => {
    const { runtime, selector, tabId } = await openedMarkdown(Buffer.from([0x23, 0x00, 0x41]))

    await expect(runtime.readMobileMarkdownTab(selector, tabId)).rejects.toThrow('binary_file')
  })

  it('shows a restored desktop draft as stale disk content and refuses a direct save', async () => {
    const harness = await createHeadlessEditorHarness((worktreeId, worktreePath) => ({
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: worktreeId,
      openFilesByWorktree: {
        [worktreeId]: [
          {
            filePath: `${worktreePath}/notes.md`,
            relativePath: 'notes.md',
            worktreeId,
            language: 'markdown',
            dirtyDraftContent: 'draft words'
          }
        ]
      }
    }))
    await harness.writeWorktreeFile('notes.md', 'disk words')
    const selector = `id:${harness.worktreeId}`
    const [tab] = (await harness.runtime.listMobileSessionTabs(selector)).tabs

    const read = await harness.runtime.readMobileMarkdownTab(selector, tab!.id)

    expect(read).toMatchObject({ content: 'disk words', isDirty: true, editable: false })
    await expect(
      harness.runtime.saveMobileMarkdownTab(selector, tab!.id, read.version, 'phone')
    ).rejects.toThrow('unsupported_tab')
    expect(await readFile(`${harness.worktreePath}/notes.md`, 'utf8')).toBe('disk words')
  })

  it('keeps a persisted read-only Markdown tab read-only', async () => {
    const harness = await createHeadlessEditorHarness((worktreeId, worktreePath) => ({
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: worktreeId,
      openFilesByWorktree: {
        [worktreeId]: [
          {
            filePath: `${worktreePath}/log.md`,
            relativePath: 'log.md',
            worktreeId,
            language: 'markdown',
            readOnly: true
          }
        ]
      }
    }))
    await harness.writeWorktreeFile('log.md', 'log')
    const selector = `id:${harness.worktreeId}`
    const [tab] = (await harness.runtime.listMobileSessionTabs(selector)).tabs

    const read = await harness.runtime.readMobileMarkdownTab(selector, tab!.id)

    expect(read).toMatchObject({ editable: false, readOnlyReason: 'unsupported_tab' })
    await expect(
      harness.runtime.saveMobileMarkdownTab(selector, tab!.id, read.version, 'x')
    ).rejects.toThrow('unsupported_tab')
    // Why: reopening the same file must not drop the read-only flag.
    await harness.runtime.openMobileFile(selector, 'log.md')
    expect(harness.getSession().openFilesByWorktree?.[harness.worktreeId]?.[0]?.readOnly).toBe(true)
  })

  it('answers tab_not_found for an unknown tab', async () => {
    const { runtime, selector } = await openedMarkdown('a')

    await expect(runtime.readMobileMarkdownTab(selector, 'nope')).rejects.toThrow('tab_not_found')
    await expect(runtime.saveMobileMarkdownTab(selector, 'nope', 'v', 'x')).rejects.toThrow(
      'tab_not_found'
    )
  })

  it('reports a save as done when the tab closes after its bytes landed', async () => {
    const { runtime, selector, tabId, filePath, worktreeId, getSession, setSession } =
      await openedMarkdown('base')
    const write = vi.spyOn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are protected runtime members with the shapes named here.
      runtime as never as { writeHostMarkdownFile: (args: never) => Promise<void> },
      'writeHostMarkdownFile'
    )
    write.mockImplementationOnce(async () => {
      await writeFile(filePath, 'landed')
      setSession({ ...getSession(), openFilesByWorktree: { [worktreeId]: [] } })
    })

    await expect(
      runtime.saveMobileMarkdownTab(selector, tabId, hashMarkdownContent('base'), 'landed')
    ).resolves.toMatchObject({ isDirty: false, content: 'landed' })
    expect(await readFile(filePath, 'utf8')).toBe('landed')
    write.mockRestore()
  })

  it('lists no tab for a row naming a file outside the workspace', async () => {
    const harness = await createHeadlessEditorHarness((worktreeId, worktreePath) => ({
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: worktreeId,
      openFilesByWorktree: {
        [worktreeId]: [
          // Absolute relative path: opened from a terminal link outside the worktree.
          {
            filePath: '/elsewhere/todo.md',
            relativePath: '/elsewhere/todo.md',
            worktreeId,
            language: 'markdown'
          },
          // Root mismatch: a source file whose row names another root.
          {
            filePath: '/elsewhere/app.ts',
            relativePath: 'app.ts',
            worktreeId,
            language: 'typescript'
          },
          // Another SSH target's file.
          {
            filePath: `${worktreePath}/remote.md`,
            relativePath: 'remote.md',
            worktreeId,
            language: 'markdown',
            externalSshTargetId: 'other-target'
          },
          {
            filePath: `${worktreePath}/inside.md`,
            relativePath: 'inside.md',
            worktreeId,
            language: 'markdown'
          }
        ]
      }
    }))

    const listed = await harness.runtime.listMobileSessionTabs(`id:${harness.worktreeId}`)

    expect(
      listed.tabs.map((tab) =>
        tab.type === 'markdown' || tab.type === 'file' ? tab.relativePath : tab.type
      )
    ).toEqual(['inside.md'])
    expect(harness.getSession().openFilesByWorktree?.[harness.worktreeId]).toHaveLength(4)
  })
})
