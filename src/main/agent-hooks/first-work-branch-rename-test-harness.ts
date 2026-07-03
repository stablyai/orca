import type { vi } from 'vitest'
import type { GlobalSettings, Repo } from '../../shared/types'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree-id'
import type {
  FirstWorkBranchRenameDeps,
  FirstWorkBranchRenameEvent
} from './first-work-branch-rename'

export const REPO_ID = 'repo1'
export const WORKTREE_ID = `${REPO_ID}${WORKTREE_ID_SEPARATOR}/repo/wt`
const FOLDER_WORKSPACE_ID = 'folder-workspace-1'
export const FOLDER_WORKTREE_ID = `folder:${FOLDER_WORKSPACE_ID}`
const TAB_ID = 'tab-1'
const PANE_KEY = `${TAB_ID}:leaf-1`

export const noUpstreamError = new Error("fatal: no upstream configured for branch 'Nautilus'")

export function gitResponder(opts: {
  currentBranch: string
  hasUpstream: boolean
  existingRefs?: string[]
}) {
  return async (args: string[]) => {
    if (args[0] === 'rev-parse' && args.some((arg) => arg.includes('@{u}'))) {
      if (opts.hasUpstream) {
        return { stdout: 'origin/x\n', stderr: '' }
      }
      throw noUpstreamError
    }
    if (args[0] === 'rev-parse') {
      return { stdout: `${opts.currentBranch}\n`, stderr: '' }
    }
    if (args[0] === 'show-ref') {
      const ref = args.at(-1) ?? ''
      if ((opts.existingRefs ?? []).includes(ref)) {
        return { stdout: '', stderr: '' }
      }
      throw new Error('not found')
    }
    if (args[0] === 'branch' && args[1] === '-m') {
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`)
  }
}

type VitestMockFactory = typeof vi.fn
type VitestMock = ReturnType<VitestMockFactory>

export function makeBranchRenameDeps(
  mockFn: VitestMockFactory,
  overrides: Partial<FirstWorkBranchRenameDeps> = {}
): {
  deps: FirstWorkBranchRenameDeps
  onRenamed: VitestMock
  setDisplayName: VitestMock
  renameWorktreeFolder: VitestMock
  setRenameError: VitestMock
} {
  const onRenamed = mockFn()
  const setDisplayName = mockFn()
  const renameWorktreeFolder = mockFn(async () => false)
  const setRenameError = mockFn()
  const settings = { autoRenameBranchFromWork: true } as unknown as GlobalSettings
  const repo = { id: REPO_ID, path: '/repo', connectionId: undefined } as unknown as Repo
  return {
    onRenamed,
    setDisplayName,
    renameWorktreeFolder,
    setRenameError,
    deps: {
      getSettings: () => settings,
      getRepo: () => repo,
      getAgentEnvResolvers: () => undefined,
      getCurrentDisplayName: () => 'Nautilus-8',
      canRenameOrcaCreatedBranch: () => true,
      setDisplayName,
      renameWorktreeFolder,
      setRenameError,
      resolveWorktreeIdForTab: () => WORKTREE_ID,
      onRenamed,
      ...overrides
    }
  }
}

export function workingEvent(
  overrides: Partial<FirstWorkBranchRenameEvent> = {}
): FirstWorkBranchRenameEvent {
  return {
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: undefined,
    state: 'working',
    prompt: 'Fix the auth bug',
    assistantMessage: undefined,
    isReplay: false,
    ...overrides
  }
}
