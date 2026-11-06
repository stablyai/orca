import { useCallback, useMemo, useRef, useState } from 'react'
import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import type { LinearIssue } from '../../../src/shared/linear/issue-types'
import { resolveComposerManualBranchNameChange } from '../../../src/shared/composer-branch-selection'
import { resolveGitHubWorkItemIdentity } from '../../../src/shared/new-workspace/github-work-item-identity'
import { getForkPushWarning } from '../../../src/shared/new-workspace/fork-push-warning'
import type { RpcClient } from '../transport/rpc-client'
import type { JiraIssue } from '../../../src/shared/jira/jira-types'
import {
  buildGitHubLinkedWorkItem,
  buildGitLabLinkedWorkItem,
  buildJiraLinkedWorkItem,
  buildLinearLinkedWorkItem,
  buildSmartNameSelection,
  resolveComposerBranchPick,
  resolveComposerCreateSelection,
  resolveJiraAutoName,
  resolveLinearAutoName,
  resolveWorkItemAutoName
} from './composer-linked-work-item'
import {
  resolveComposerHostedItemBase,
  toComposerBaseState,
  type ComposerHostedBase
} from './composer-source-base-resolve'
import type {
  ComposerBaseState,
  MobileComposerCreateSelection,
  MobileLinkedWorkItem,
  SmartNameSelection
} from './mobile-composer-source-types'
import { useMobileComposerName } from './use-mobile-composer-name'
import { getBaseResolveError, useForkPushWarning } from './composer-source-copy'

export type UseMobileComposerSourceArgs = {
  client: RpcClient | null
  selectedRepoId: string | null
  worktreeBranches?: readonly string[]
  onError?: (message: string) => void
}

export function useMobileComposerSource(args: UseMobileComposerSourceArgs) {
  const { client, selectedRepoId, worktreeBranches = [], onError } = args
  const [linkedWorkItem, setLinkedWorkItem] = useState<MobileLinkedWorkItem | null>(null)
  const [base, setBase] = useState<ComposerBaseState>({})
  const [reuseEligibleBranch, setReuseEligibleBranch] = useState<string | null>(null)
  const [reuseSelectedBranch, setReuseSelectedBranch] = useState(false)
  const [forkPushWarning, setForkPushWarning] = useForkPushWarning()
  const [resolvingBase, setResolvingBase] = useState(false)
  const [branchCreateIntent, setBranchCreateIntent] = useState(false)

  const branchSelectionRef = useRef<{ refName: string; localBranchName: string } | null>(null)
  const resolveTokenRef = useRef(0)

  const { name, setName, setNameState, lastAutoNameRef, applyAutoName, isNameAutoManaged } =
    useMobileComposerName(linkedWorkItem)

  const clearBaseAndBranch = useCallback(() => {
    branchSelectionRef.current = null
    setBranchCreateIntent(false)
    setBase({})
    setReuseEligibleBranch(null)
    setReuseSelectedBranch(false)
    setForkPushWarning(null)
    // Superseding the token retires the old finally, so clear resolvingBase here to avoid a stuck spinner.
    setResolvingBase(false)
  }, [])

  const runBaseResolve = useCallback(
    (token: number, resolve: Promise<ComposerHostedBase>) => {
      setResolvingBase(true)
      void resolve
        .then((result) => {
          if (resolveTokenRef.current !== token) {
            return
          }
          setBase(toComposerBaseState(result))
          setForkPushWarning(getForkPushWarning(result))
        })
        .catch((error: unknown) => {
          if (resolveTokenRef.current === token) {
            setBase({})
            onError?.(getBaseResolveError(error))
          }
        })
        .finally(() => {
          if (resolveTokenRef.current === token) {
            setResolvingBase(false)
          }
        })
    },
    [onError]
  )

  // Cross-repo selection can precede selectedRepoId committing.
  const selectHostedItem = useCallback(
    (args: {
      item: {
        repoId?: string
        type: 'issue' | 'pr' | 'mr'
        number: number
        branchName?: string
        baseRefName?: string
        isCrossRepository?: boolean
      }
      provider: 'github' | 'gitlab'
      linked: MobileLinkedWorkItem
      autoName: string
    }) => {
      const token = (resolveTokenRef.current += 1)
      const repoId = args.item.repoId || selectedRepoId
      setLinkedWorkItem(args.linked)
      applyAutoName(args.autoName, name)
      clearBaseAndBranch()
      if (!client || !repoId) {
        return
      }
      const pending = resolveComposerHostedItemBase({
        ...args.item,
        client,
        repoId,
        provider: args.provider
      })
      if (pending) {
        runBaseResolve(token, pending)
      }
    },
    [applyAutoName, clearBaseAndBranch, client, name, runBaseResolve, selectedRepoId]
  )

  const handleSmartGitHubItemSelect = useCallback(
    (item: GitHubWorkItem) => {
      const identity = resolveGitHubWorkItemIdentity(item)
      selectHostedItem({
        item: { ...item, ...identity },
        provider: 'github',
        linked: buildGitHubLinkedWorkItem({
          ...identity,
          title: item.title,
          url: item.url,
          repoId: item.repoId
        }),
        autoName: resolveWorkItemAutoName({ ...identity, title: item.title, provider: 'github' })
      })
    },
    [selectHostedItem]
  )

  const handleSmartGitLabItemSelect = useCallback(
    (item: GitLabWorkItem) => {
      selectHostedItem({
        item,
        provider: 'gitlab',
        linked: buildGitLabLinkedWorkItem({
          type: item.type,
          number: item.number,
          title: item.title,
          url: item.url,
          repoId: item.repoId
        }),
        autoName: resolveWorkItemAutoName({
          type: item.type,
          number: item.number,
          title: item.title,
          provider: 'gitlab'
        })
      })
    },
    [selectHostedItem]
  )

  const selectIdentifiedIssue = useCallback(
    (args: { linked: MobileLinkedWorkItem; suggested: string; identifier: string }) => {
      resolveTokenRef.current += 1
      setLinkedWorkItem(args.linked)
      // Lookup-query text may adopt the resolved issue’s name.
      const identifierTyped =
        !linkedWorkItem && name.trim().toLowerCase() === args.identifier.toLowerCase()
      if (identifierTyped && args.suggested) {
        setNameState(args.suggested)
        lastAutoNameRef.current = args.suggested
      } else {
        applyAutoName(args.suggested, name)
      }
      clearBaseAndBranch()
    },
    [applyAutoName, clearBaseAndBranch, lastAutoNameRef, linkedWorkItem, name, setNameState]
  )

  const handleSmartLinearIssueSelect = useCallback(
    (issue: LinearIssue) =>
      selectIdentifiedIssue({
        linked: buildLinearLinkedWorkItem(issue),
        suggested: resolveLinearAutoName(issue),
        identifier: issue.identifier
      }),
    [selectIdentifiedIssue]
  )

  const handleSmartJiraIssueSelect = useCallback(
    (issue: JiraIssue) =>
      selectIdentifiedIssue({
        linked: buildJiraLinkedWorkItem(issue),
        suggested: resolveJiraAutoName(issue),
        identifier: issue.key
      }),
    [selectIdentifiedIssue]
  )

  const handleSmartBranchSelect = useCallback(
    (refName: string, localBranchName: string) => {
      resolveTokenRef.current += 1
      setLinkedWorkItem(null)
      setForkPushWarning(null)
      setBranchCreateIntent(false)
      setResolvingBase(false)
      const pick = resolveComposerBranchPick({
        refName,
        localBranchName,
        currentName: name,
        lastAutoName: lastAutoNameRef.current,
        worktreeBranches
      })
      setReuseEligibleBranch(pick.reuseEligibleBranch)
      setReuseSelectedBranch(pick.reuseSelectedBranch)
      setBase(pick.base)
      branchSelectionRef.current = { refName, localBranchName }
      if (pick.name !== undefined) {
        setNameState(pick.name)
        lastAutoNameRef.current = pick.lastAutoName ?? ''
      }
    },
    [name, worktreeBranches]
  )

  const handleSmartCreateBranch = useCallback(
    (branchName: string) => {
      resolveTokenRef.current += 1
      setLinkedWorkItem(null)
      clearBaseAndBranch()
      setNameState(branchName)
      lastAutoNameRef.current = branchName
      setBranchCreateIntent(true)
    },
    [clearBaseAndBranch]
  )

  const handleClearSmartNameSelection = useCallback(() => {
    resolveTokenRef.current += 1
    setLinkedWorkItem(null)
    clearBaseAndBranch()
    setResolvingBase(false)
    if (name === lastAutoNameRef.current) {
      setNameState('')
      lastAutoNameRef.current = ''
    }
  }, [clearBaseAndBranch, name])

  const handleBranchNameOverrideChange = useCallback(
    (value: string) => {
      setReuseSelectedBranch(false)
      const { forkPushWarning: nextWarning, ...nextBase } = resolveComposerManualBranchNameChange({
        value,
        pushTarget: base.pushTarget,
        forkPushWarning
      })
      setBase({ ...base, ...nextBase })
      setForkPushWarning(nextWarning)
    },
    [base, forkPushWarning]
  )

  const smartNameSelection = useMemo<SmartNameSelection | null>(
    () => buildSmartNameSelection({ linkedWorkItem, baseBranch: base.baseBranch }),
    [base.baseBranch, linkedWorkItem]
  )

  const createSelection = useMemo<MobileComposerCreateSelection | null>(
    () =>
      resolveComposerCreateSelection({
        linkedWorkItem,
        base,
        branch: branchSelectionRef.current,
        reuseEligibleBranch,
        reuseSelectedBranch,
        branchCreateIntent,
        name
      }),
    [base, branchCreateIntent, linkedWorkItem, name, reuseEligibleBranch, reuseSelectedBranch]
  )

  return {
    name,
    setName,
    linkedWorkItem,
    branchNameOverride: base.branchNameOverride,
    handleBranchNameOverrideChange,
    reuseEligibleBranch,
    reuseSelectedBranch,
    setReuseSelectedBranch: (next: boolean) => {
      setReuseSelectedBranch(next)
      setBase((current) => ({
        ...current,
        branchNameOverride: next ? (reuseEligibleBranch ?? undefined) : undefined
      }))
    },
    forkPushWarning,
    resolvingBase,
    isNameAutoManaged,
    smartNameSelection,
    createSelection,
    handleSmartGitHubItemSelect,
    handleSmartGitLabItemSelect,
    handleSmartLinearIssueSelect,
    handleSmartJiraIssueSelect,
    handleSmartBranchSelect,
    handleSmartCreateBranch,
    handleClearSmartNameSelection
  }
}

export type MobileComposerSource = ReturnType<typeof useMobileComposerSource>
