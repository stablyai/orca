import { ipcMain } from 'electron'
import type {
  GlobalSettings,
  TuiAgent,
  WikiGenerateResult,
  WikiReadResult
} from '../../shared/types'
import { readWikiNote, readWikiOverview, resolveWikiTarget } from '../wiki/wiki-repository'
import { readWikiNoteSsh, readWikiOverviewSsh } from '../wiki/wiki-repository-ssh'
import { buildWikiGenerationPrompt, readWikiTemplateFile } from '../wiki/wiki-generation-prompt'
import { resolveWikiGenerationAgent } from '../wiki/wiki-agent-selection'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { WikiGenerationStatus } from '../wiki/wiki-generation-service'

const SSH_NOT_SUPPORTED_ERROR = 'Background wiki generation is not available for SSH worktrees yet.'

export type WikiHandlerDeps = {
  getWorktree: (
    worktreeId: string
  ) => { path: string; repoName: string; connectionId?: string } | null
  getSettings: () => Pick<
    GlobalSettings,
    'defaultTuiAgent' | 'disabledTuiAgents' | 'sourceControlAi'
  >
  generation: {
    start: (input: {
      worktreeId: string
      cwd: string
      agent: TuiAgent
      prompt: string
    }) => { ok: true } | { ok: false; error: string }
    getStatus: (worktreeId: string) => WikiGenerationStatus | null
    cancel: (worktreeId: string) => void
  }
}

type WikiOverview = { hasWiki: boolean; rootRelativePath: string | null; notes: string[] }
type WikiNote = { relativePath: string; content: string } | null

export function registerWikiHandlers(deps: WikiHandlerDeps): void {
  ipcMain.handle(
    'wiki:read',
    async (
      _event,
      args: { worktreeId: string; target?: string; fromRelativePath?: string }
    ): Promise<WikiReadResult> => {
      const worktree = deps.getWorktree(args.worktreeId)
      if (!worktree) {
        return { hasWiki: false }
      }

      let readOverview: () => Promise<WikiOverview>
      let readNote: (relativePath: string) => Promise<WikiNote>
      if (worktree.connectionId) {
        const provider = getSshFilesystemProvider(worktree.connectionId)
        if (!provider) {
          return { hasWiki: false }
        }
        readOverview = () => readWikiOverviewSsh(provider, worktree.path, worktree.repoName)
        readNote = (relativePath) => readWikiNoteSsh(provider, worktree.path, relativePath)
      } else {
        readOverview = () => readWikiOverview(worktree.path, worktree.repoName)
        readNote = (relativePath) => readWikiNote(worktree.path, relativePath)
      }

      const overview = await readOverview()
      if (!overview.hasWiki || !overview.rootRelativePath) {
        return { hasWiki: false }
      }
      const requested =
        args.target && args.fromRelativePath
          ? resolveWikiTarget(overview.notes, args.fromRelativePath, args.target)
          : (args.target ?? overview.rootRelativePath)
      const relativePath = requested ?? overview.rootRelativePath
      const note = await readNote(relativePath)
      return { hasWiki: true, rootRelativePath: overview.rootRelativePath, note }
    }
  )

  ipcMain.handle(
    'wiki:generate',
    async (
      _event,
      args: { worktreeId: string; addClaudeMdInstruction?: boolean }
    ): Promise<WikiGenerateResult> => {
      const worktree = deps.getWorktree(args.worktreeId)
      if (!worktree) {
        return { ok: false, error: 'No active worktree.' }
      }
      if (worktree.connectionId) {
        return { ok: false, error: SSH_NOT_SUPPORTED_ERROR }
      }
      const resolved = resolveWikiGenerationAgent(deps.getSettings())
      if (!resolved.ok) {
        return resolved
      }
      const prompt = await buildWikiGenerationPrompt({
        repoName: worktree.repoName,
        readTemplateFile: readWikiTemplateFile,
        addClaudeMdInstruction: args.addClaudeMdInstruction ?? false
      })
      return deps.generation.start({
        worktreeId: args.worktreeId,
        cwd: worktree.path,
        agent: resolved.agent,
        prompt
      })
    }
  )

  ipcMain.handle(
    'wiki:generationStatus',
    (_event, args: { worktreeId: string }): WikiGenerationStatus | null =>
      deps.generation.getStatus(args.worktreeId)
  )

  ipcMain.handle('wiki:cancelGeneration', (_event, args: { worktreeId: string }): { ok: true } => {
    deps.generation.cancel(args.worktreeId)
    return { ok: true }
  })
}
