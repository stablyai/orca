import {
  assertCodexAccountLaunchRequest,
  type AgentLaunchAccountReceipt
} from '../../shared/agent-launch-account'
import type { Repo } from '../../shared/repo-types'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import { assertNativeCodexAccountPlacement } from './runtime-codex-account-placement'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'

export type RuntimeAgentLaunchAccountArgs = {
  account?: string
  agent?: string
  terminal?: string
  on?: string
  worktree?: string
  repo?: string
  cwd?: string
}
type AccountResolver = (
  args: RuntimeAgentLaunchAccountArgs
) => Promise<AgentLaunchAccountReceipt | undefined>

export async function resolveRuntimeAgentLaunchAccount(
  args: RuntimeAgentLaunchAccountArgs,
  ports: {
    resolveAccount: (selector: string) => AgentLaunchAccountReceipt
    resolveWorkspace: (selector: string) => Promise<TerminalWorkspaceLaunchScope>
    showRepo: (selector: string) => Promise<Repo>
    getStore: () => RuntimeStore
    canSpawn: () => boolean
  }
): Promise<AgentLaunchAccountReceipt | undefined> {
  if (args.account === undefined) {
    return undefined
  }
  assertCodexAccountLaunchRequest(args)
  if (!ports.canSpawn()) {
    throw new Error('--account requires an available native terminal launcher.')
  }
  const account = ports.resolveAccount(args.account)
  const workspace = args.worktree ? await ports.resolveWorkspace(args.worktree) : null
  const repo = workspace?.repo ?? (args.repo ? await ports.showRepo(args.repo) : null)
  const cwd = args.cwd ?? workspace?.path ?? repo?.path
  if (!cwd) {
    throw new Error('--account requires an execution workspace or repository.')
  }
  assertNativeCodexAccountPlacement({
    store: ports.getStore(),
    repo,
    executionHostId: workspace?.executionHostId ?? workspace?.folderWorkspace?.executionHostId,
    connectionId: workspace?.connectionId,
    worktreeId: workspace?.id,
    cwd
  })
  return account
}

export function assertPinnedCodexTerminalOptions(
  workspace: TerminalWorkspaceLaunchScope,
  opts: TerminalCreateOptions,
  store: RuntimeStore
): void {
  assertCodexAccountLaunchRequest({
    account: 'resolved',
    agent: opts.startupAgent ?? opts.launchAgent
  })
  assertNativeCodexAccountPlacement({
    store,
    repo: workspace.repo,
    executionHostId: workspace.executionHostId ?? workspace.folderWorkspace?.executionHostId,
    connectionId: workspace.connectionId,
    worktreeId: workspace.id,
    cwd: resolveTerminalStartupCwd(workspace.path, opts.cwd) ?? workspace.path,
    shellOverride: opts.shellOverride
  })
  if (
    opts.resumeProviderSession ||
    opts.sessionId ||
    opts.agentSessionClaim ||
    opts.rendererBacked
  ) {
    throw new Error(
      '--account requires a fresh native terminal; resume, adoption and renderer-backed launch are unsupported.'
    )
  }
}

export async function prepareRuntimeWorktreeLaunchAccount(
  request: RuntimeManagedWorktreeCreateArgs,
  resolveAccount: AccountResolver,
  canSpawn: boolean
): Promise<{
  request: RuntimeManagedWorktreeCreateArgs
  account?: AgentLaunchAccountReceipt
}> {
  if (request.startupAccount === undefined) {
    return { request }
  }
  if (request.startup || request.startupDraft || !canSpawn) {
    throw new Error(
      '--account requires a fresh native startup agent; explicit startup commands and drafts are unsupported.'
    )
  }
  const account = await resolveAccount({
    account: request.startupAccount,
    agent: request.startupAgent,
    repo: request.repoSelector,
    cwd: request.startupCwd
  })
  if (!account) {
    throw new Error('The runtime could not resolve the pinned Codex account.')
  }
  return { request: { ...request, startupCodexAccountId: account.effective.id }, account }
}
