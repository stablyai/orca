import path from 'node:path'
import type {
  LineageAddManualLinkArgs,
  LineageAddManualLinkResult,
  LineageRemoveManualLinkArgs,
  LineageRemoveManualLinkResult
} from '../../shared/fleet-lineage-types'
import type { LineageManualLink } from '../../shared/lineage-discovery-types'
import {
  lineageManualLinkDedupeKey,
  normalizeLineageWorktreePath
} from '../../shared/lineage-manual-link-shape'
import {
  parsePullRequestReference,
  type ParsedPullRequestReference
} from '../../shared/lineage-pr-reference'
import { isFolderRepo } from '../../shared/repo-kind'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree/id'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { listRepoWorktrees, type PatternRepo } from './lineage-name-pattern-discovery'
import type { LineagePullRequestLookup } from './lineage-pr-head-branch'
import type { LineageStoreContract } from './workspace-lineage-service'

const MAX_REFERENCE_LENGTH = 2048
const MAX_BRANCH_LENGTH = 1024
const MAX_PATH_LENGTH = 4096

export type LineageManualLinkDeps = {
  /** Best effort; null, '' or a throw leave the link without a branch. */
  lookupPullRequestHeadBranch?: (
    repo: PatternRepo,
    pr: LineagePullRequestLookup
  ) => Promise<string | null>
  /** The repo's worktrees as git lists them; a local worktree link must name one of them. */
  listRepoWorktrees?: (repo: PatternRepo) => Promise<GitWorktreeInfo[]>
}

type Failure = { success: false; error: string }
type Draft = {
  link: Omit<LineageManualLink, 'id' | 'addedAt'>
  repo: PatternRepo
  pr?: ParsedPullRequestReference
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : null
}

function fail(error: string): Failure {
  return { success: false, error }
}

function findRepoById(store: LineageStoreContract, repoId: string): PatternRepo | undefined {
  return store.getRepos?.().find((candidate) => candidate.id === repoId)
}

function draftPullRequest(store: LineageStoreContract, reference: unknown): Draft | Failure {
  if (!isNonEmptyString(reference, MAX_REFERENCE_LENGTH)) {
    return fail('Invalid pull request reference')
  }
  const parsed = parsePullRequestReference(reference)
  if (!parsed) {
    return fail('Unrecognized pull request reference')
  }
  const repo = store
    .getRepos?.()
    .find((candidate) => candidate.displayName.toLowerCase() === parsed.repoName.toLowerCase())
  if (!repo) {
    return fail('Repository not registered in Orca')
  }
  return {
    repo,
    pr: parsed,
    link: {
      kind: 'pr',
      repoName: repo.displayName,
      repoId: repo.id,
      number: parsed.number,
      ...(parsed.url ? { url: parsed.url } : {})
    }
  }
}

function findGitRepo(store: LineageStoreContract, repoId: unknown): PatternRepo | Failure {
  if (!isNonEmptyString(repoId, MAX_REFERENCE_LENGTH)) {
    return fail('Invalid repository')
  }
  const repo = findRepoById(store, repoId)
  if (!repo) {
    return fail('Repository not registered in Orca')
  }
  if (isFolderRepo(repo)) {
    return fail('Folder projects have no branches or worktrees')
  }
  return repo
}

async function draftTarget(
  store: LineageStoreContract,
  rawTarget: unknown,
  deps: LineageManualLinkDeps
): Promise<Draft | Failure> {
  const target = readRecord(rawTarget)
  if (!target) {
    return fail('Invalid target')
  }
  if (target.kind === 'pr') {
    return draftPullRequest(store, target.reference)
  }
  if (target.kind === 'branch') {
    const repo = findGitRepo(store, target.repoId)
    if ('success' in repo) {
      return repo
    }
    const branch =
      typeof target.branch === 'string' ? target.branch.replace(/^refs\/heads\//, '') : ''
    if (!isNonEmptyString(branch, MAX_BRANCH_LENGTH)) {
      return fail('Invalid branch')
    }
    return { repo, link: { kind: 'branch', repoName: repo.displayName, repoId: repo.id, branch } }
  }
  if (target.kind === 'worktree') {
    const repo = findGitRepo(store, target.repoId)
    if ('success' in repo) {
      return repo
    }
    const rawPath = target.worktreePath
    // why: an SSH worktree path is POSIX on the remote host even when this host is Windows
    if (
      !isNonEmptyString(rawPath, MAX_PATH_LENGTH) ||
      !(path.posix.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath))
    ) {
      return fail('Invalid worktree path')
    }
    let worktreePath = normalizeLineageWorktreePath(rawPath)
    // hazard: an SSH worktree lives on its host; it is stored as named, never checked against local git
    if (!repo.connectionId) {
      const listed = await (deps.listRepoWorktrees ?? listRepoWorktrees)(repo)
      const match = listed.find(
        (worktree) => !worktree.isBare && path.resolve(worktree.path) === path.resolve(rawPath)
      )
      if (!match) {
        return fail('Worktree is not part of this repository')
      }
      worktreePath = match.path
    }
    return {
      repo,
      link: {
        kind: 'worktree',
        repoName: repo.displayName,
        repoId: repo.id,
        worktreePath,
        worktreeId: `${repo.id}${WORKTREE_ID_SEPARATOR}${worktreePath}`
      }
    }
  }
  return fail('Invalid target')
}

function findDuplicate(
  store: LineageStoreContract,
  parentWorkspaceKey: string,
  link: Omit<LineageManualLink, 'id' | 'addedAt'>
): LineageManualLink | undefined {
  const repos = store.getRepos?.() ?? []
  // why: links saved before repo ids carry only a name; key them by the repo that name registers today
  const withRepoId = (candidate: Omit<LineageManualLink, 'id' | 'addedAt'>): LineageManualLink => ({
    ...candidate,
    id: '',
    addedAt: 0,
    repoId:
      candidate.repoId ??
      repos.find((repo) => repo.displayName.toLowerCase() === candidate.repoName.toLowerCase())?.id
  })
  const key = lineageManualLinkDedupeKey(withRepoId(link))
  return (store.getLineageManualLinks?.(parentWorkspaceKey) ?? []).find(
    (existing) => lineageManualLinkDedupeKey(withRepoId(existing)) === key
  )
}

async function lookupBranch(
  deps: LineageManualLinkDeps,
  draft: Draft
): Promise<string | undefined> {
  if (!draft.pr) {
    return undefined
  }
  try {
    const { repoName, number, provider, owner, host } = draft.pr
    const branch = await deps.lookupPullRequestHeadBranch?.(draft.repo, {
      repoName,
      number,
      ...(provider ? { provider } : {}),
      ...(owner ? { owner } : {}),
      ...(host ? { host } : {})
    })
    return typeof branch === 'string' && branch.length > 0 ? branch : undefined
  } catch {
    // why: the head branch only helps match a local worktree; a failed lookup never fails the add
    return undefined
  }
}

export async function addLineageManualLink(
  store: LineageStoreContract,
  args: LineageAddManualLinkArgs,
  deps: LineageManualLinkDeps = {}
): Promise<LineageAddManualLinkResult> {
  // hazard: IPC payloads are untrusted at runtime despite the static types
  const raw = readRecord(args)
  if (!raw) {
    return fail('Invalid request')
  }
  if (!isNonEmptyString(raw.parentWorkspaceKey, MAX_REFERENCE_LENGTH)) {
    return fail('Invalid parent workspace key')
  }
  const parentWorkspaceKey = raw.parentWorkspaceKey
  const draft =
    raw.target === undefined
      ? draftPullRequest(store, raw.reference)
      : await draftTarget(store, raw.target, deps)
  if ('success' in draft) {
    return draft
  }
  const before = findDuplicate(store, parentWorkspaceKey, draft.link)
  if (before) {
    return { success: true, link: before }
  }
  const branch = await lookupBranch(deps, draft)
  // invariant: re-check after the await; another add may have stored the same link meanwhile
  const after = findDuplicate(store, parentWorkspaceKey, draft.link)
  if (after) {
    return { success: true, link: after }
  }
  const link: LineageManualLink = {
    id: crypto.randomUUID(),
    ...draft.link,
    ...(branch ? { branch } : {}),
    addedAt: Date.now()
  }
  const existing = store.getLineageManualLinks?.(parentWorkspaceKey) ?? []
  store.setLineageManualLinks?.(parentWorkspaceKey, [...existing, link])
  return { success: true, link }
}

export function removeLineageManualLink(
  store: LineageStoreContract,
  args: LineageRemoveManualLinkArgs
): LineageRemoveManualLinkResult {
  if (
    !isNonEmptyString(args?.parentWorkspaceKey, MAX_REFERENCE_LENGTH) ||
    !isNonEmptyString(args?.linkId, MAX_REFERENCE_LENGTH)
  ) {
    return { success: false }
  }
  const existing = store.getLineageManualLinks?.(args.parentWorkspaceKey) ?? []
  store.setLineageManualLinks?.(
    args.parentWorkspaceKey,
    existing.filter((link) => link.id !== args.linkId)
  )
  return { success: true }
}
