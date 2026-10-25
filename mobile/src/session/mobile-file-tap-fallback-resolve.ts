import type { RuntimeTerminalPathResolution } from '../../../src/shared/runtime-types'
import { fileUriToFilesystemPath } from '../../../src/shared/file-uri-path'
import { resumeWorktreeListRead } from '../agent-history/mobile-agent-history-operations'
import { fileTapPathResolve } from './mobile-session-launch-operations'
import type { FileTapSessionTab, OpenMobileFileTapOptions } from './mobile-file-tap-open'

function normalizePathSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function pathMatchesSuffixCaseInsensitive(candidatePath: string, suffixPath: string): boolean {
  const normCandidate = normalizePathSlashes(candidatePath).toLowerCase()
  const normSuffix = normalizePathSlashes(suffixPath).replace(/^\.\//, '').toLowerCase()
  if (!normCandidate || !normSuffix) {
    return false
  }
  return normCandidate === normSuffix || normCandidate.endsWith(`/${normSuffix}`)
}

async function tryResolveCandidatePath<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>,
  worktreeSelector: string,
  pathText: string
): Promise<RuntimeTerminalPathResolution | null> {
  try {
    const response = await fileTapPathResolve.request(
      options.client,
      {
        worktree: worktreeSelector,
        pathText,
        crossWorkspace: true
      },
      { timeoutMs: 10_000 }
    )
    const accepted = fileTapPathResolve.interpret(response)
    if (!accepted.accepted) {
      return null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
    const resolved = accepted.value as RuntimeTerminalPathResolution
    return resolved.exists && !resolved.isDirectory ? resolved : null
  } catch {
    return null
  }
}

export async function resolveMissingTerminalFileTap<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>,
  initialResolved: RuntimeTerminalPathResolution
): Promise<RuntimeTerminalPathResolution | null> {
  const worktree = `id:${options.worktreeId}`

  if (options.terminalHandle && initialResolved.absolutePath?.startsWith('//')) {
    const withoutTerminal = await tryResolveCandidatePath(options, worktree, options.pathText)
    if (withoutTerminal) {
      return withoutTerminal
    }
  }

  for (const tab of options.getSessionTabs()) {
    if (
      tab.relativePath &&
      tab.relativePath !== options.pathText &&
      pathMatchesSuffixCaseInsensitive(tab.relativePath, options.pathText)
    ) {
      const fromTab = await tryResolveCandidatePath(options, worktree, tab.relativePath)
      if (fromTab) {
        return fromTab
      }
    }
  }

  if (
    options.nativeChatContext ||
    /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/]|file:\/\/)/i.test(options.pathText)
  ) {
    return null
  }

  try {
    const psResponse = await resumeWorktreeListRead.request(options.client, {}, { timeoutMs: 3_000 })
    const psAccepted = resumeWorktreeListRead.interpret(psResponse)
    if (!psAccepted.accepted) {
      return null
    }
    const rawWorktrees = psAccepted.value?.worktrees
    if (!Array.isArray(rawWorktrees) || rawWorktrees.length === 0) {
      return null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.ps rows carry optional worktreeId/id/isActive/lastActivityAt/agents
    const worktrees = [...(rawWorktrees as Record<string, unknown>[])].sort((a, b) => {
      const aId =
        typeof a.worktreeId === 'string' ? a.worktreeId : typeof a.id === 'string' ? a.id : ''
      const bId =
        typeof b.worktreeId === 'string' ? b.worktreeId : typeof b.id === 'string' ? b.id : ''
      if (aId === options.worktreeId && bId !== options.worktreeId) {
        return -1
      }
      if (bId === options.worktreeId && aId !== options.worktreeId) {
        return 1
      }
      const aTime = typeof a.lastActivityAt === 'number' ? a.lastActivityAt : 0
      const bTime = typeof b.lastActivityAt === 'number' ? b.lastActivityAt : 0
      return bTime - aTime
    })

    const triedPaths = new Set<string>()
    for (const wt of worktrees) {
      const agents = Array.isArray(wt.agents) ? wt.agents : []
      for (const ag of agents) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: agent rows are objects with optional lastAssistantMessage
        const msg =
          typeof (ag as Record<string, unknown>)?.lastAssistantMessage === 'string'
            ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowed to string above
              ((ag as Record<string, unknown>).lastAssistantMessage as string)
            : ''
        if (!msg) {
          continue
        }
        const matches = msg.match(/file:\/\/\/[^\s)"'\]>]+/gi) ?? []
        for (const rawUri of matches) {
          const hashIdx = rawUri.indexOf('#')
          const baseUri = hashIdx !== -1 ? rawUri.slice(0, hashIdx) : rawUri
          let fsPath: string | null = null
          try {
            fsPath = fileUriToFilesystemPath(new URL(baseUri))
          } catch {
            fsPath = null
          }
          if (!fsPath || triedPaths.has(fsPath)) {
            continue
          }
          if (pathMatchesSuffixCaseInsensitive(fsPath, options.pathText)) {
            triedPaths.add(fsPath)
            const resolvedFromUri = await tryResolveCandidatePath(options, worktree, fsPath)
            if (resolvedFromUri) {
              return resolvedFromUri
            }
          }
        }
      }
    }

    let siblingProbes = 0
    for (const wt of worktrees) {
      const wtId =
        typeof wt.worktreeId === 'string' ? wt.worktreeId : typeof wt.id === 'string' ? wt.id : ''
      if (!wtId || wtId === options.worktreeId) {
        continue
      }
      const isLive =
        wt.isActive === true ||
        (typeof wt.liveTerminalCount === 'number' && wt.liveTerminalCount > 0)
      if (!isLive) {
        continue
      }
      siblingProbes += 1
      if (siblingProbes > 6) {
        break
      }
      const fromSibling = await tryResolveCandidatePath(options, `id:${wtId}`, options.pathText)
      if (fromSibling) {
        return fromSibling
      }
    }
  } catch {
    // Best-effort fallback
  }

  return null
}
