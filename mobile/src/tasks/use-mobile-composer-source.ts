import { useCallback, useMemo, useRef, useState } from 'react'
import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import type { LinearIssue } from '../../../src/shared/linear/issue-types'
import { resolveComposerManualBranchNameChange } from '../../../src/shared/composer-branch-selection'
import { resolveGitHubWorkItemIdentity } from '../../../src/shared/new-workspace/github-work-item-identity'
import { getForkPushWarning } from '../../../src/shared/new-workspace/fork-push-warning'
import type { RpcClient } from '../transport/rpc-client'
import type { JiraIssue } from '../../../src/shared/jira-types'
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
  resolveWorkItemAutoName,
  shouldApplyAutoName
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
const EMPTY_BASE: ComposerBaseState = {}

export type UseMobileComposerSourceArgs = {
  client: RpcClient | null
  selectedRepoId: string | null
  worktreeBranches?: readonly string[]
  onError?: (message: string) => void
}

export function useMobileComposerSource(args: UseMobileComposerSourceArgs) {
  const { client, selectedRepoId, worktreeBranches = [], onError } = args
  const [name, setNameState] = useState('')
  const [linkedWorkItem, setLinkedWorkItem] = useState<MobileLinkedWorkItem | null>(null)
  const [base, setBase] = useState<ComposerBaseState>(EMPTY_BASE)
  const [reuseEligibleBranch, setReuseEligibleBranch] = useState<string | null>(null)
  const [reuseSelectedBranch, setReuseSelectedBranch] = useState(false)
  const [forkPushWarning, setForkPushWarning] = useState<string | null>(null)
  const [resolvingBase, setResolvingBase] = useState(false)
  // Set when the "Create branch <name>" row is picked, so the typed name (which
  // may contain slashes) is kept verbatim as the git branch (folder is sanitized).
  const [branchCreateIntent, setBranchCreateIntent] = useState(false)

  const lastAutoNameRef = useRef('')
  const branchSelectionRef = useRef<{ refName: string; localBranchName: string } | null>(null)
  // Guards async base resolution: only the latest selection applies its result.
  const resolveTokenRef = useRef(0)

  const setName = useCallback((value: string) => setNameState(value), [])

  const applyAutoName = useCallback((suggested: string, currentName: string, force = false) => {
    if (
      suggested &&
      (force || shouldApplyAutoName({ currentName, lastAutoName: lastAutoNameRef.current }))
    ) {
      setNameState(suggested)
      lastAutoNameRef.current = suggested
    }
  }, [])

  const clearBaseAndBranch = useCallback(() => {
    branchSelectionRef.current = null
    setBranchCreateIntent(false)
    setBase(EMPTY_BASE)
    setReuseEligibleBranch(null)
    setReuseSelectedBranch(false)
    setForkPushWarning(null)
    // Why: a superseding selection bumps the resolve token, so an in-flight base
    // resolve's token-gated finally can no longer clear this — reset it here so
    // resolvingBase never sticks true after switching sources.
    setResolvingBase(false)
  }, [])

  // Applies an async PR/MR base resolution guarded by the current token so only
  // the latest selection wins; failures clear the base and surface the error.
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
          if (resolveTokenRef.current !== token) {
            return
          }
          setBase(EMPTY_BASE)
          onError?.(error instanceof Error ? error.message : 'Failed to resolve base branch.')
        })
        .finally(() => {
          if (resolveTokenRef.current === token) {
            setResolvingBase(false)
          }
        })
    },
    [onError]
  )

  // Both hosted providers link the item, adopt the derived name, then resolve the
  // review base against the item's OWN repo — a cross-repo accept switches repos
  // and selects synchronously, so selectedRepoId is stale by the time we read it.
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

  // Linear and Jira share the shape: link the issue, adopt the derived name
  // unless the user typed their own, and drop any repo-derived base/branch.
  const selectIdentifiedIssue = useCallback(
    (args: { linked: MobileLinkedWorkItem; suggested: string; identifier: string }) => {
      resolveTokenRef.current += 1
      setLinkedWorkItem(args.linked)
      // Typing the bare identifier is an explicit ask for that issue's name, so it
      // overrides the usual "don't clobber a user-typed name" gate.
      const identifierTyped = name.trim().toLowerCase() === args.identifier.toLowerCase()
      applyAutoName(args.suggested, name, identifierTyped)
      clearBaseAndBranch()
    },
    [applyAutoName, clearBaseAndBranch, name]
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

  // Picking "Create branch <name>": name the workspace and mark a new-branch
  // intent so the typed (possibly slashy) name is kept verbatim as the git branch.
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

  // Auto-managed until the user edits the name away from the last derived value;
  // desktop suppresses the workspace displayName once the name is user-edited.
  const isNameAutoManaged = !name.trim() || name === lastAutoNameRef.current

  return {
    name,
    setName,
    linkedWorkItem,
    branchNameOverride: base.branchNameOverride,
    handleBranchNameOverrideChange,
    reuseEligibleBranch,
    reuseSelectedBranch,
    setReuseSelectedBranch,
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
