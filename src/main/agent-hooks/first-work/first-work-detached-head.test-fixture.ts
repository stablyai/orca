import { expect } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session/agent-session-wire'
import type { FirstWorkRetryDeps } from './first-work-rename-retry'

export type GitRoute = 'native' | 'direct' | 'login'
export type GitChild = { route: GitRoute; args: string[]; timeout: number | undefined }
export type GitReply = { stdout: string } | { error: Error }
export type GitReplier = (child: GitChild) => GitReply | Promise<GitReply>

export const REPO_ID = 'repo-1'
export const WORKTREE_PATH = '/orca-test-fixture/worktrees/nautilus'
export const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
export const INCARNATION = 'incarnation-1'

/** Mirrors the routed command the real resolver builds, keyed by route for the capture seam. */
export function routedCommand(route: GitRoute, args: string[], cwd: string) {
  return {
    binary: route,
    args,
    cwd,
    wsl: route === 'native' ? null : { distro: 'Fixture', linuxPath: '/w' },
    wslMode: route === 'native' ? null : route === 'direct' ? 'direct-git' : 'login-shell'
  } as const
}

export function gitExit(
  code: number,
  stderr: string,
  extra: Record<string, unknown> = {}
): GitReply {
  return { error: Object.assign(new Error(`git exited ${code}`), { code, stderr, ...extra }) }
}

export const quietMiss = (): GitReply => gitExit(1, '')
export const head = (): GitReply => ({ stdout: 'HEAD\n' })
export const onBranch = (name: string): GitReply => ({ stdout: `refs/heads/${name}\n` })

export function routeOf(binary: string): GitRoute {
  if (binary === 'native' || binary === 'direct' || binary === 'login') {
    return binary
  }
  throw new Error(`unexpected route ${binary}`)
}

export function workingSummary(prompt = 'fix the login bug'): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: WORKTREE_ID,
    agent: 'claude',
    status: 'working',
    latestPrompt: prompt,
    updatedAt: 0
  }
}

export const isSymbolicRef = (child: GitChild) => child.args.includes('symbolic-ref')

/** Detached on every route: quiet symbolic-ref miss, then `HEAD` from the confirmation. */
export const detachedReplier: GitReplier = (child) => (isSymbolicRef(child) ? quietMiss() : head())

export function createDeps(overrides: Partial<FirstWorkRetryDeps> = {}): FirstWorkRetryDeps {
  return {
    readIncarnation: () => INCARNATION,
    getSettings: () => ({ autoRenameBranchFromWork: true, branchPrefix: 'none' }),
    getRepo: () => ({
      id: REPO_ID,
      path: '/orca-test-fixture/repo',
      displayName: 'repo',
      badgeColor: '#000000',
      addedAt: 0
    }),
    getAgentEnvResolvers: () => undefined,
    getCurrentDisplayName: () => undefined,
    canRenameOrcaCreatedBranch: () => true,
    setDisplayName: () => {},
    setRenameError: () => {},
    resolveWorktreeIdForTab: () => undefined,
    onRenamed: () => {},
    getWorkspaceCreatedAt: () => undefined,
    getBaseRef: () => undefined,
    nativeReads: () => ({
      listSessions: async () => ({ sessionIds: [], hasUnreadable: false }),
      readFirst: async () => ({ kind: 'none' })
    }),
    ...overrides
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Real event-loop turns; timers stay faked so cooldown time only moves when a test moves it. */
export async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) {
    await turn()
  }
  expect(predicate()).toBe(true)
}

export async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await turn()
  }
}
