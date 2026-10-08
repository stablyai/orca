/**
 * The host changes editor tabs only while no live window document could later persist a session
 * it read earlier. A promoted window whose hand-over timed out or failed is still alive, so editor
 * actions refuse (retryably) until its late graph attaches; a gone renderer or a closed window
 * hands editors to the host, and a replacement document is assigned before it reads the session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { EDITOR_AUTHORITY_CHANGED_ERROR, EDITOR_WINDOW_STARTING_ERROR } from './editor-authority'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const {
  HEADLESS_RUNTIME_WINDOW_ID,
  RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
  electronMocks,
  getDefaultWorkspaceSession
} = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_WINDOW_ID } = await import('./orca-runtime-test-fixtures.spec')
const {
  attachEditorWindow,
  createHeadlessEditorHarness,
  detachEditorWindow,
  mockLiveEditorWindow,
  runtimeFileCommands
} = await import('./host-editor-tabs-test-harness.spec')

function lateWindowGraph(runtime: { syncWindowGraph: (id: number, graph: never) => unknown }) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a renderer graph is the synced shape plus its generation, which syncWindowGraph accepts.
  return runtime.syncWindowGraph(TEST_WINDOW_ID, {
    tabs: [],
    leaves: [],
    rendererGeneration: 'gen-late'
  } as never)
}

function sessionWithNotes(worktreeId: string, worktreePath: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: {
      [worktreeId]: [
        {
          filePath: `${worktreePath}/notes.md`,
          relativePath: 'notes.md',
          worktreeId,
          language: 'markdown'
        }
      ]
    }
  }
}

/** A serve host whose desktop promotion fell back to headless while its window stays open. */
async function recoveredPromotion(
  recovery: 'failed' | 'timeout',
  initialSession?: Parameters<typeof createHeadlessEditorHarness>[0]
) {
  const harness = await createHeadlessEditorHarness(initialSession)
  const { runtime, worktreeId } = harness
  await harness.writeWorktreeFile('notes.md', 'a')
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  // Listed while the host owned editors, so the phone holds the tab ids it will act on.
  const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
  const editor = attachEditorWindow(runtime)
  if (recovery === 'failed') {
    runtime.markGraphReloadFailed(TEST_WINDOW_ID, 'renderer-frame-unavailable')
  } else {
    await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS)
  }
  expect(runtime.getStatus().authoritativeWindowId).toBe(HEADLESS_RUNTIME_WINDOW_ID)
  return { ...harness, editor, listed }
}

function mockGoneRenderer(gone: 'crashed' | 'destroyed'): void {
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn(),
      isDestroyed: () => gone === 'destroyed',
      isCrashed: () => gone === 'crashed'
    }
  }
  electronMocks.BrowserWindow.fromId.mockImplementation((id: number) =>
    id === TEST_WINDOW_ID ? window : null
  )
}

describe.each(['failed', 'timeout'] as const)('editor tabs after a %s promotion', (recovery) => {
  afterEach(() => {
    electronMocks.BrowserWindow.fromId.mockImplementation(() => null)
    vi.useRealTimers()
  })

  it('refuses every editor action retryably and writes no session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { runtime, worktreeId, getSession, listed, editor } = await recoveredPromotion(
      recovery,
      sessionWithNotes
    )
    const [notes] = listed.tabs
    expect(notes).toMatchObject({ type: 'markdown', relativePath: 'notes.md' })
    const before = structuredClone(getSession())
    const selector = `id:${worktreeId}`

    await expect(runtime.openMobileFile(selector, 'notes.md')).rejects.toThrow(
      EDITOR_WINDOW_STARTING_ERROR
    )
    await expect(runtime.openMobileDiff(selector, 'a.ts', false)).rejects.toThrow(
      EDITOR_WINDOW_STARTING_ERROR
    )
    await expect(runtime.readMobileMarkdownTab(selector, notes!.id)).rejects.toThrow(
      EDITOR_WINDOW_STARTING_ERROR
    )
    await expect(runtime.saveMobileMarkdownTab(selector, notes!.id, 'v', 'b')).rejects.toThrow(
      EDITOR_WINDOW_STARTING_ERROR
    )
    await expect(runtime.closeMobileSessionTab(selector, notes!.id)).rejects.toThrow(
      EDITOR_WINDOW_STARTING_ERROR
    )
    await expect(runtime.activateMobileSessionTab(selector, notes!.id)).rejects.toThrow(
      EDITOR_WINDOW_STARTING_ERROR
    )
    await expect(
      runtime.moveMobileSessionTab(selector, {
        kind: 'reorder',
        tabId: notes!.id,
        targetGroupId: listed.activeGroupId ?? '',
        tabOrder: [notes!.id]
      })
    ).rejects.toThrow(EDITOR_WINDOW_STARTING_ERROR)

    expect(getSession()).toEqual(before)
    expect(editor.openFile).not.toHaveBeenCalled()
    expect(editor.closeSessionTab).not.toHaveBeenCalled()
  })

  it('the late graph still attaches and then the window owns opens', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { runtime, worktreeId, getSession, editor } = await recoveredPromotion(recovery)

    lateWindowGraph(runtime)

    expect(runtime.getStatus().authoritativeWindowId).toBe(TEST_WINDOW_ID)
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    expect(editor.openFile).toHaveBeenCalledTimes(1)
    expect(getSession().openFilesByWorktree?.[worktreeId] ?? []).toEqual([])
  })

  it.each(['crashed', 'destroyed'] as const)(
    'a %s renderer hands editors to the host; its reload is assigned before it reads',
    async (gone) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { runtime, worktreeId, getSession, editor } = await recoveredPromotion(recovery)
      mockGoneRenderer(gone)

      await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
      expect(getSession().openFilesByWorktree?.[worktreeId]).toHaveLength(1)

      // The reload's navigation start assigns the window before the new document reads.
      mockLiveEditorWindow()
      runtime.markRendererReloading(TEST_WINDOW_ID)
      expect(runtime.getStatus().authoritativeWindowId).toBe(TEST_WINDOW_ID)
      await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
      expect(editor.openFile).toHaveBeenCalledTimes(1)
      expect(getSession().openFilesByWorktree?.[worktreeId]).toEqual([
        expect.objectContaining({ relativePath: 'notes.md' })
      ])
      expect(() => lateWindowGraph(runtime)).not.toThrow()
    }
  )
})

describe('a closed desktop window', () => {
  afterEach(() => {
    electronMocks.BrowserWindow.fromId.mockImplementation(() => null)
  })

  it('hands editors to the host, and a reopened window restores what the host wrote', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness()
    await writeWorktreeFile('notes.md', 'a')
    attachEditorWindow(runtime)
    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [], rendererGeneration: 'g-1' })
    runtime.markGraphUnavailable(TEST_WINDOW_ID)
    detachEditorWindow(runtime)

    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    expect(getSession().openFilesByWorktree?.[worktreeId]).toHaveLength(1)

    const reopened = attachEditorWindow(runtime)
    expect(runtime.getStatus().authoritativeWindowId).toBe(TEST_WINDOW_ID)
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    expect(reopened.openFile).toHaveBeenCalledTimes(1)
    expect(getSession().openFilesByWorktree?.[worktreeId]).toEqual([
      expect.objectContaining({ relativePath: 'notes.md' })
    ])
    detachEditorWindow(runtime)
  })
})

describe('a paired phone closing host editor tabs after the window closed', () => {
  afterEach(() => {
    electronMocks.BrowserWindow.fromId.mockImplementation(() => null)
  })

  // The graph stays unavailable once the last window closes, on a desktop and on a promoted serve host.
  async function closedWindowHost(mode: 'desktop' | 'serve-promoted') {
    const harness = await createHeadlessEditorHarness()
    const { runtime } = harness
    await harness.writeWorktreeFile('notes.md', 'a')
    if (mode === 'serve-promoted') {
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      attachEditorWindow(runtime)
      lateWindowGraph(runtime)
    } else {
      attachEditorWindow(runtime)
      runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [], rendererGeneration: 'g-1' })
    }
    runtime.markGraphUnavailable(TEST_WINDOW_ID)
    detachEditorWindow(runtime)
    expect(runtime.getStatus().graphStatus).toBe('unavailable')
    return harness
  }

  it.each(['desktop', 'serve-promoted'] as const)(
    'closes edit and diff tabs on a %s host',
    async (mode) => {
      const { runtime, worktreeId, getSession } = await closedWindowHost(mode)
      const selector = `id:${worktreeId}`
      await runtime.openMobileFile(selector, 'notes.md')
      await runtime.openMobileDiff(selector, 'a.ts', false)
      const tabs = (await runtime.listMobileSessionTabs(selector)).tabs
      const notes = tabs.find((tab) => tab.type === 'markdown')
      const diff = tabs.find((tab) => tab.type === 'file')

      await expect(
        runtime.closeMobileSessionTab(selector, notes!.id, { clientNavigationId: 'phone-1' })
      ).resolves.toMatchObject({ closed: true })
      await expect(
        runtime.closeMobileSessionTab(selector, diff!.id, { clientNavigationId: 'phone-1' })
      ).resolves.toMatchObject({ closed: true })

      expect(getSession().openFilesByWorktree?.[worktreeId]).toEqual([])
      expect((await runtime.listMobileSessionTabs(selector)).tabs).toEqual([])
    }
  )

  it('still refuses a terminal close that needs the graph', async () => {
    const { runtime, worktreeId } = await closedWindowHost('desktop')

    await expect(
      runtime.closeMobileSessionTab(`id:${worktreeId}`, 'term-1', { clientNavigationId: 'phone-1' })
    ).rejects.toThrow('runtime_unavailable')
  })
})

describe('an open that crosses a window attach', () => {
  afterEach(() => {
    electronMocks.BrowserWindow.fromId.mockImplementation(() => null)
  })

  it('refuses with a retryable error, writes no row, and the next tap takes the window route', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness()
    await writeWorktreeFile('notes.md', 'a')
    const commands = runtimeFileCommands(runtime)
    const original = commands.assertOpenTargetIsFile.bind(commands)
    let editor: Record<string, ReturnType<typeof vi.fn>> = {}
    vi.spyOn(commands, 'assertOpenTargetIsFile').mockImplementationOnce(
      async (...args: unknown[]) => {
        await original(...args)
        editor = attachEditorWindow(runtime)
      }
    )

    await expect(runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')).rejects.toThrow(
      EDITOR_AUTHORITY_CHANGED_ERROR
    )
    expect(getSession().openFilesByWorktree?.[worktreeId] ?? []).toEqual([])
    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([])

    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    expect(editor.openFile).toHaveBeenCalledTimes(1)
  })

  it('refuses a diff open that crosses an attach the same way', async () => {
    const { runtime, worktreeId } = await createHeadlessEditorHarness()
    const commands = runtimeFileCommands(runtime)
    const original = commands.assertHostDiffGitTarget.bind(commands)
    vi.spyOn(commands, 'assertHostDiffGitTarget').mockImplementationOnce(
      async (...args: unknown[]) => {
        await original(...args)
        attachEditorWindow(runtime)
      }
    )

    await expect(runtime.openMobileDiff(`id:${worktreeId}`, 'a.ts', false)).rejects.toThrow(
      EDITOR_AUTHORITY_CHANGED_ERROR
    )
  })
})
