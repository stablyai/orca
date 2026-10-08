import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import {
  OrcaRuntimeService,
  electronMocks,
  getDefaultWorkspaceSession,
  listWorktrees
} from './orca-runtime-test-mocks.spec'
import type { WorkspaceSessionState } from './orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  makeRuntimeStoreWithWorkspaceSession
} from './orca-runtime-test-fixtures.spec'

export type HostEditorHarness = {
  runtime: InstanceType<typeof OrcaRuntimeService>
  worktreeId: string
  worktreePath: string
  getSession: () => WorkspaceSessionState
  setSession: (next: WorkspaceSessionState) => void
  writeWorktreeFile: (relativePath: string, content: string | Buffer) => Promise<string>
}

/** A runtime with no desktop window over a real temp worktree, like `orca serve`. */
export async function createHeadlessEditorHarness(
  initialSession: (worktreeId: string, worktreePath: string) => WorkspaceSessionState = (
    worktreeId
  ) => ({
    ...getDefaultWorkspaceSession(),
    activeRepoId: TEST_REPO_ID,
    activeWorktreeId: worktreeId
  })
): Promise<HostEditorHarness> {
  const worktreePath = await mkdtemp(join(tmpdir(), 'orca-host-editor-tabs-'))
  const worktreeId = `${TEST_REPO_ID}::${worktreePath}`
  vi.mocked(listWorktrees).mockResolvedValue([
    {
      path: worktreePath,
      head: 'abc',
      branch: 'feature/notes',
      isBare: false,
      isMainWorktree: false
    }
  ])
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    initialSession(worktreeId, worktreePath)
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session fixture store implements every store method these headless paths call.
  const runtime = new OrcaRuntimeService(runtimeStore as never)
  return {
    runtime,
    worktreeId,
    worktreePath,
    getSession,
    setSession,
    writeWorktreeFile: async (relativePath, content) => {
      const filePath = join(worktreePath, relativePath)
      await mkdir(join(filePath, '..'), { recursive: true })
      await writeFile(filePath, content)
      return filePath
    }
  }
}

/** Gives the runtime an authoritative desktop window whose notifier owns editor tabs. */
export function attachEditorWindow(
  runtime: InstanceType<typeof OrcaRuntimeService>,
  notifier: Record<string, unknown> = {}
): Record<string, ReturnType<typeof vi.fn>> {
  const editor = {
    openFile: vi.fn(),
    openDiff: vi.fn(),
    readMobileMarkdownTab: vi.fn(),
    saveMobileMarkdownTab: vi.fn(),
    closeSessionTab: vi.fn(),
    focusEditorTab: vi.fn(),
    moveSessionTab: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the editor paths call only the notifier methods stubbed here.
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    ...editor,
    ...notifier
  } as never)
  mockLiveEditorWindow()
  runtime.attachWindow(TEST_WINDOW_ID)
  return editor
}

/** Only the test window id resolves; the headless authority id must never look like a window. */
export function mockLiveEditorWindow(): void {
  const window = {
    isDestroyed: () => false,
    webContents: { send: vi.fn(), isDestroyed: () => false }
  }
  electronMocks.BrowserWindow.fromId.mockImplementation((id: number) =>
    id === TEST_WINDOW_ID ? window : null
  )
}

export function detachEditorWindow(runtime: InstanceType<typeof OrcaRuntimeService>): void {
  runtime.setNotifier(null)
  electronMocks.BrowserWindow.fromId.mockImplementation(() => null)
}

type ProtectedFileCommands = {
  assertOpenTargetIsFile: (...args: unknown[]) => Promise<void>
  assertHostDiffGitTarget: (...args: unknown[]) => Promise<void>
  writeFileExplorerFile: (...args: unknown[]) => Promise<unknown>
}

/** The runtime's protected file commands, so a test can interpose between their awaits. */
export function runtimeFileCommands(
  runtime: InstanceType<typeof OrcaRuntimeService>
): ProtectedFileCommands {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every OrcaRuntimeService holds a RuntimeFileCommands with these methods in `fileCommands`.
  return (runtime as unknown as { fileCommands: ProtectedFileCommands }).fileCommands
}
