import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import {
  buildSmartWorkspaceSourceRows,
  getSmartWorkspaceEmptyHint,
  isBlockingJiraUrlIntent,
  type SmartNameMode,
  type SmartWorkspaceSourceRow
} from '../../../src/shared/new-workspace/smart-workspace-source-results'
import type { JiraIssue, JiraSite, JiraSiteSelection } from '../../../src/shared/jira-types'
import type { RpcClient } from '../transport/rpc-client'
import { fanOutSmartSearch, type SmartFanOutResult } from './smart-source-fan-out'
import { lookupJiraIssueByUrl } from './jira-mobile-url-lookup'
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
  client: RpcClient | null
  enabled: boolean
  mode: SmartNameMode
  query: string
  repoId: string | null
  githubAvailable: boolean
  gitlabAvailable: boolean
  linearAvailable: boolean
  jiraAvailable: boolean
  mrStateFilter: MrStateFilter
  linearWorkspaceId?: string | null
  jiraSiteId?: JiraSiteSelection | null
  jiraSites: readonly JiraSite[]
  repos: readonly PasteRepoCandidate[]
}

const EMPTY_FAN: SmartFanOutResult = {
  githubItems: [],
  gitlabItems: [],
  linearIssues: [],
  jiraIssues: [],
  branches: [],
  needsGitHubRemote: false,
  error: ''
}

type PasteResolved = {
  github: GitHubWorkItem | null
  gitlab: GitLabWorkItem | null
  jira: JiraIssue | null
}

const EMPTY_PASTE: PasteResolved = { github: null, gitlab: null, jira: null }

export function useSmartWorkspaceSource(args: UseSmartWorkspaceSourceArgs) {
  const {
    client,
    enabled,
    mode,
    query,
    repoId,
    githubAvailable,
    gitlabAvailable,
    linearAvailable,
    jiraAvailable,
    mrStateFilter,
    linearWorkspaceId,
    jiraSiteId,
    jiraSites,
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
    if (!client || !enabled || mode === 'text') {
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
        client,
        mode,
        query,
        repoId,
        githubAvailable,
        gitlabAvailable,
        linearAvailable,
        jiraAvailable,
        mrStateFilter,
        linearWorkspaceId,
        jiraSiteId,
        jiraSites,
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
    client,
    enabled,
    mode,
    query,
    repoId,
    githubAvailable,
    gitlabAvailable,
    linearAvailable,
    jiraAvailable,
    mrStateFilter,
    linearWorkspaceId,
    jiraSiteId,
    jiraSites,
    repos
  ])

  const rows = useMemo<SmartWorkspaceSourceRow[]>(
    () =>
      buildSmartWorkspaceSourceRows({
        branches: fan.branches,
        githubItems: paste.github ? [paste.github] : fan.githubItems,
        gitlabAvailable,
        gitlabItems: paste.gitlab ? [paste.gitlab] : fan.gitlabItems,
        jiraIntent: isBlockingJiraUrlIntent(mode, query),
        jiraIssue: paste.jira,
        jiraIssues: fan.jiraIssues,
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

async function runSmartSearch(args: {
  client: RpcClient
  mode: SmartNameMode
  query: string
  repoId: string | null
  githubAvailable: boolean
  gitlabAvailable: boolean
  linearAvailable: boolean
  jiraAvailable: boolean
  mrStateFilter: MrStateFilter
  linearWorkspaceId: string | null | undefined
  jiraSiteId: JiraSiteSelection | null | undefined
  jiraSites: readonly JiraSite[]
  repos: readonly PasteRepoCandidate[]
  dismissedPasteRef: { current: string }
  repoSlugCache: Map<string, { owner: string; repo: string; host?: string } | null>
}): Promise<{
  fan: SmartFanOutResult
  paste: PasteResolved
  crossRepoPrompt: SmartCrossRepoPrompt | null
}> {
  const { client, mode, query, repoId, repos, dismissedPasteRef, repoSlugCache } = args
  const paste: PasteResolved = { ...EMPTY_PASTE }

  // A pasted Jira URL resolves to exactly one issue, so skip the fan-out entirely
  // rather than paying for provider searches the row builder will discard.
  if (args.jiraAvailable && isBlockingJiraUrlIntent(mode, query)) {
    try {
      paste.jira = await lookupJiraIssueByUrl(client, query, args.jiraSites)
    } catch {
      // Best-effort: an unresolvable link renders the empty state.
    }
    return { fan: EMPTY_FAN, paste, crossRepoPrompt: null }
  }

  const fan = await fanOutSmartSearch(args)
  let crossRepoPrompt: SmartCrossRepoPrompt | null = null

  const intent =
    mode === 'branches' || dismissedPasteRef.current === query.trim()
      ? null
      : resolvePasteIntent(query)
  if (intent && repoId) {
    try {
      if (intent.kind === 'github-number') {
        paste.github = await lookupGitHubItemByNumber(client, repoId, intent.number)
      } else if (intent.kind === 'github-link') {
        const matchingRepo = await findRepoMatchingSlugForPaste(
          client,
          repos,
          intent.link.slug,
          repoSlugCache
        )
        if (matchingRepo && matchingRepo.id !== repoId) {
          crossRepoPrompt = { link: intent.link, matchingRepo }
        } else {
          paste.github = await lookupGitHubItemByOwnerRepo(
            client,
            repoId,
            intent.link.slug,
            intent.link.number,
            intent.link.type
          )
        }
      } else if (intent.kind === 'gitlab-link') {
        paste.gitlab = await lookupGitLabItemByPath(client, repoId, intent.link)
      }
    } catch {
      // Best-effort paste resolution; fall back to the fan-out results.
    }
  }
  return { fan, paste, crossRepoPrompt }
}
