import { useCallback, useMemo, useRef, useState } from 'react'
import type { GitHubWorkItem, GitLabWorkItem, LinearIssue } from '../../../src/shared/types'
import { resolveComposerManualBranchNameChange } from '../../../src/shared/composer-branch-selection'
import { resolveGitHubWorkItemIdentity } from '../../../src/shared/new-workspace/github-work-item-identity'
import { getForkPushWarning } from '../../../src/shared/new-workspace/fork-push-warning'
import type { RpcClient } from '../transport/rpc-client'
import {
  buildGitHubLinkedWorkItem,
  buildGitLabLinkedWorkItem,
  buildLinearLinkedWorkItem,
  buildSmartNameSelection,
  resolveComposerBranchPick,
  resolveComposerCreateSelection,
  resolveLinearAutoName,
  resolveWorkItemAutoName,
  shouldApplyAutoName
} from './composer-linked-work-item'
import {
  resolveComposerMrBase,
  resolveComposerPrBase,
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

  const applyAutoName = useCallback((suggested: string, currentName: string) => {
    if (suggested && shouldApplyAutoName({ currentName, lastAutoName: lastAutoNameRef.current })) {
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
          setBase({
            baseBranch: result.baseBranch,
            compareBaseRef: result.compareBaseRef,
            pushTarget: result.pushTarget,
            branchNameOverride: result.branchNameOverride
          })
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

  const handleSmartGitHubItemSelect = useCallback(
    (item: GitHubWorkItem) => {
      const token = (resolveTokenRef.current += 1)
      const identity = resolveGitHubWorkItemIdentity(item)
      // Resolve the PR base against the item's OWN repo — a cross-repo accept
      // switches repos then selects synchronously, so selectedRepoId is stale.
      const repoId = item.repoId || selectedRepoId
      setLinkedWorkItem(
        buildGitHubLinkedWorkItem({
          type: identity.type,
          number: identity.number,
          title: item.title,
          url: item.url,
          repoId: item.repoId
        })
      )
      applyAutoName(
        resolveWorkItemAutoName({ ...identity, title: item.title, provider: 'github' }),
        name
      )
      clearBaseAndBranch()
      if (identity.type !== 'pr' || !client || !repoId) {
        return
      }
      runBaseResolve(
        token,
        resolveComposerPrBase({
          client,
          repoId,
          prNumber: identity.number,
          ...(item.branchName ? { headRefName: item.branchName } : {}),
          ...(item.baseRefName ? { baseRefName: item.baseRefName } : {}),
          ...(item.isCrossRepository !== undefined
            ? { isCrossRepository: item.isCrossRepository }
            : {})
        })
      )
    },
    [applyAutoName, clearBaseAndBranch, client, name, runBaseResolve, selectedRepoId]
  )

  const handleSmartGitLabItemSelect = useCallback(
    (item: GitLabWorkItem) => {
      const token = (resolveTokenRef.current += 1)
      // Resolve the MR base against the item's OWN repo (see the GitHub handler).
      const repoId = item.repoId || selectedRepoId
      setLinkedWorkItem(
        buildGitLabLinkedWorkItem({
          type: item.type,
          number: item.number,
          title: item.title,
          url: item.url,
          repoId: item.repoId
        })
      )
      applyAutoName(
        resolveWorkItemAutoName({
          type: item.type,
          number: item.number,
          title: item.title,
          provider: 'gitlab'
        }),
        name
      )
      clearBaseAndBranch()
      if (item.type !== 'mr' || !client || !repoId) {
        return
      }
      runBaseResolve(
        token,
        resolveComposerMrBase({
          client,
          repoId,
          mrIid: item.number,
          ...(item.branchName ? { sourceBranch: item.branchName } : {}),
          ...(item.baseRefName ? { targetBranch: item.baseRefName } : {}),
          ...(item.isCrossRepository !== undefined
            ? { isCrossRepository: item.isCrossRepository }
            : {})
        })
      )
    },
    [applyAutoName, clearBaseAndBranch, client, name, runBaseResolve, selectedRepoId]
  )

  const handleSmartLinearIssueSelect = useCallback(
    (issue: LinearIssue) => {
      resolveTokenRef.current += 1
      setLinkedWorkItem(buildLinearLinkedWorkItem(issue))
      const suggested = resolveLinearAutoName(issue)
      const identifierTyped = name.trim().toLowerCase() === issue.identifier.toLowerCase()
      if (
        suggested &&
        (identifierTyped ||
          shouldApplyAutoName({ currentName: name, lastAutoName: lastAutoNameRef.current }))
      ) {
        setNameState(suggested)
        lastAutoNameRef.current = suggested
      }
      clearBaseAndBranch()
    },
    [clearBaseAndBranch, name]
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
      const next = resolveComposerManualBranchNameChange({
        value,
        pushTarget: base.pushTarget,
        forkPushWarning
      })
      setBase({
        ...base,
        branchNameOverride: next.branchNameOverride,
        pushTarget: next.pushTarget
      })
      setForkPushWarning(next.forkPushWarning)
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
    handleSmartBranchSelect,
    handleSmartCreateBranch,
    handleClearSmartNameSelection
  }
}

export type MobileComposerSource = ReturnType<typeof useMobileComposerSource>
