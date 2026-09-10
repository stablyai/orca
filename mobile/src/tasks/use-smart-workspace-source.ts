import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import {
  buildSmartWorkspaceSourceRows,
  getSmartWorkspaceEmptyHint,
  type SmartNameMode,
  type SmartWorkspaceSourceRow
} from '../../../src/shared/new-workspace/smart-workspace-source-results'
import type { HostWorkspaceCreationOperations } from '../worktree/host-workspace-creation-operations'
import { fanOutSmartSearch, type SmartFanOutResult } from './smart-source-fan-out'
import type { MrStateFilter } from './mobile-composer-source-types'
import {
  findRepoMatchingSlugForPaste,
  lookupGitHubItemByNumber,
  lookupGitHubItemByOwnerRepo,
  lookupGitLabItemByPath,
  resolvePasteIntent,
  type PasteRepoCandidate
} from './smart-source-paste-intent'

const DEBOUNCE_MS = 200
const RESULT_LIMIT = 36

export type SmartCrossRepoPrompt = {
  link: {
    slug: { owner: string; repo: string; host?: string }
    number: number
    type: 'issue' | 'pr'
  }
  matchingRepo: PasteRepoCandidate
}

export type UseSmartWorkspaceSourceArgs = {
  operations: HostWorkspaceCreationOperations | null
  enabled: boolean
  mode: SmartNameMode
  query: string
  repoId: string | null
  githubAvailable: boolean
  gitlabAvailable: boolean
  linearAvailable: boolean
  mrStateFilter: MrStateFilter
  linearWorkspaceId?: string | null
  repos: readonly PasteRepoCandidate[]
}

const EMPTY_FAN: SmartFanOutResult = {
  githubItems: [],
  gitlabItems: [],
  linearIssues: [],
  branches: [],
  needsGitHubRemote: false,
  error: ''
}

type PasteResolved = { github: GitHubWorkItem | null; gitlab: GitLabWorkItem | null }
const EMPTY_PASTE: PasteResolved = { github: null, gitlab: null }

export function useSmartWorkspaceSource(args: UseSmartWorkspaceSourceArgs) {
  const {
    operations,
    enabled,
    mode,
    query,
    repoId,
    githubAvailable,
    gitlabAvailable,
    linearAvailable,
    mrStateFilter,
    linearWorkspaceId,
    repos
  } = args
  const [fan, setFan] = useState<SmartFanOutResult>(EMPTY_FAN)
  const [paste, setPaste] = useState<PasteResolved>(EMPTY_PASTE)
  const [loading, setLoading] = useState(false)
  const [crossRepoPrompt, setCrossRepoPrompt] = useState<SmartCrossRepoPrompt | null>(null)
  // Why: preserve results across keystrokes (debounce) but drop them the moment
  // the mode/repo changes so one provider's rows never render under another tab.
  const scopeRef = useRef('')
  const dismissedPasteRef = useRef<string>('')
  const repoSlugCacheRef = useRef<
    Map<string, { owner: string; repo: string; host?: string } | null>
  >(new Map())

  useEffect(() => {
    if (!operations || !enabled || mode === 'text') {
      setFan(EMPTY_FAN)
      setPaste(EMPTY_PASTE)
      setLoading(false)
      setCrossRepoPrompt(null)
      return
    }
    const scope = `${mode}:${repoId ?? ''}`
    const scopeChanged = scopeRef.current !== scope
    scopeRef.current = scope
    if (scopeChanged) {
      setFan(EMPTY_FAN)
      setPaste(EMPTY_PASTE)
      setCrossRepoPrompt(null)
    }
    setLoading(true)
    let stale = false
    const timer = setTimeout(() => {
      void runSmartSearch({
        operations,
        mode,
        query,
        repoId,
        githubAvailable,
        gitlabAvailable,
        linearAvailable,
        mrStateFilter,
        linearWorkspaceId,
        repos,
        dismissedPasteRef,
        repoSlugCache: repoSlugCacheRef.current
      })
        .then((result) => {
          if (stale) {
            return
          }
          setFan(result.fan)
          setPaste(result.paste)
          setCrossRepoPrompt(result.crossRepoPrompt)
          setLoading(false)
        })
        .catch(() => {
          if (!stale) {
            setLoading(false)
          }
        })
    }, DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [
    operations,
    enabled,
    mode,
    query,
    repoId,
    githubAvailable,
    gitlabAvailable,
    linearAvailable,
    mrStateFilter,
    linearWorkspaceId,
    repos
  ])

  const rows = useMemo<SmartWorkspaceSourceRow[]>(
    () =>
      buildSmartWorkspaceSourceRows({
        branches: fan.branches,
        githubItems: paste.github ? [paste.github] : fan.githubItems,
        gitlabAvailable,
        gitlabItems: paste.gitlab ? [paste.gitlab] : fan.gitlabItems,
        linearAvailable,
        linearIssues: fan.linearIssues,
        mode,
        resultLimit: RESULT_LIMIT,
        value: query
      }),
    [fan, gitlabAvailable, linearAvailable, mode, paste, query]
  )

  const dismissCrossRepoPrompt = useCallback(() => {
    dismissedPasteRef.current = query.trim()
    setCrossRepoPrompt(null)
  }, [query])

  return {
    rows,
    loading,
    error: fan.error,
    needsGitHubRemote: fan.needsGitHubRemote,
    emptyHint: getSmartWorkspaceEmptyHint(mode),
    crossRepoPrompt,
    dismissCrossRepoPrompt
  }
}

type PasteLookup = { paste: PasteResolved; crossRepoPrompt: SmartCrossRepoPrompt | null }

const EMPTY_PASTE_LOOKUP: PasteLookup = {
  paste: { github: null, gitlab: null },
  crossRepoPrompt: null
}

// Resolves a pasted issue/PR/MR reference to the exact item it names.
async function resolvePastedItem(args: {
  operations: HostWorkspaceCreationOperations
  intent: NonNullable<ReturnType<typeof resolvePasteIntent>>
  repoId: string
  repos: readonly PasteRepoCandidate[]
  repoSlugCache: Map<string, { owner: string; repo: string; host?: string } | null>
}): Promise<PasteLookup> {
  const { operations, intent, repoId, repos, repoSlugCache } = args
  if (intent.kind === 'github-number') {
    return {
      paste: {
        github: await lookupGitHubItemByNumber(operations, repoId, intent.number),
        gitlab: null
      },
      crossRepoPrompt: null
    }
  }
  if (intent.kind === 'github-link') {
    const matchingRepo = await findRepoMatchingSlugForPaste(
      operations,
      repos,
      intent.link.slug,
      repoSlugCache
    )
    if (matchingRepo && matchingRepo.id !== repoId) {
      return {
        paste: { github: null, gitlab: null },
        crossRepoPrompt: { link: intent.link, matchingRepo }
      }
    }
    return {
      paste: {
        github: await lookupGitHubItemByOwnerRepo(
          operations,
          repoId,
          intent.link.slug,
          intent.link.number,
          intent.link.type
        ),
        gitlab: null
      },
      crossRepoPrompt: null
    }
  }
  return {
    paste: {
      github: null,
      gitlab: await lookupGitLabItemByPath(operations, repoId, intent.link)
    },
    crossRepoPrompt: null
  }
}

async function runSmartSearch(args: {
  operations: HostWorkspaceCreationOperations
  mode: SmartNameMode
  query: string
  repoId: string | null
  githubAvailable: boolean
  gitlabAvailable: boolean
  linearAvailable: boolean
  mrStateFilter: MrStateFilter
  linearWorkspaceId: string | null | undefined
  repos: readonly PasteRepoCandidate[]
  dismissedPasteRef: { current: string }
  repoSlugCache: Map<string, { owner: string; repo: string; host?: string } | null>
}): Promise<{
  fan: SmartFanOutResult
  paste: PasteResolved
  crossRepoPrompt: SmartCrossRepoPrompt | null
}> {
  const { operations, mode, query, repoId, repos, dismissedPasteRef, repoSlugCache } = args
  const intent =
    mode === 'branches' || dismissedPasteRef.current === query.trim()
      ? null
      : resolvePasteIntent(query)
  // Why: the paste lookup and the provider fan-out hit different host endpoints,
  // so awaiting the fan-out first stacked two full round trips on the one path a
  // user is most likely to take — typing a PR/issue number. Run them together.
  const [fan, pasteLookup] = await Promise.all([
    fanOutSmartSearch(args),
    intent && repoId
      ? resolvePastedItem({ operations, intent, repoId, repos, repoSlugCache }).catch(
          // Best-effort paste resolution; fall back to the fan-out results.
          () => EMPTY_PASTE_LOOKUP
        )
      : Promise.resolve(EMPTY_PASTE_LOOKUP)
  ])
  return { fan, paste: pasteLookup.paste, crossRepoPrompt: pasteLookup.crossRepoPrompt }
}
