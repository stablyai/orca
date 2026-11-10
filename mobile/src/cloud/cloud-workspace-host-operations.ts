import { z } from 'zod'
import { isTuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent-config'
import { agentLaunchReplayRun } from '../tasks/mobile-workspace-create-operations'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import type { UnvalidatedRpcRequestPort } from '../transport/rpc/unvalidated-rpc-request-port'
import type { QueuedCloudPrompt } from './cloud-prompt-queue'

// What the phone does on a cloud VM's own orcad once attached: register the cloned project the VM
// booted with, and start agents in it with a prompt.

/** Where the control plane clones the repo; the create response confirms it. */
export const CLOUD_DEFAULT_PROJECT_ROOT = '/vercel/sandbox/project'

const RepoSchema = z.looseObject({ id: z.string(), path: z.string() })

const cloudRepoList = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.list-cloud-project',
    method: 'repo.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('cloud-repos', z.object({ repos: z.array(RepoSchema) }))
  })
)

const cloudRepoAdd = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.add-cloud-project',
    method: 'repo.add',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('cloud-repo-added', z.object({ repo: RepoSchema }))
  })
)

const cloudWorktreeList = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.list-cloud-project',
    method: 'worktree.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'cloud-worktrees',
      z.object({ worktrees: z.array(z.looseObject({ id: z.string(), path: z.string() })) })
    )
  })
)

function samePath(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
}

/** The cloud project's main worktree id, registering the project on first use. */
export async function ensureCloudProjectWorktree(
  client: UnvalidatedRpcRequestPort,
  recordedRoot?: string
): Promise<string> {
  const projectRoot = recordedRoot ?? CLOUD_DEFAULT_PROJECT_ROOT
  const { repos } = cloudRepoList.interpret(await cloudRepoList.request(client))
  // Sandboxes register their one project at boot; with no recorded root, that repo is the project.
  const repo =
    repos.find((entry) => samePath(entry.path, projectRoot)) ??
    (repos.length === 1 && !recordedRoot ? repos[0] : undefined) ??
    cloudRepoAdd.interpret(await cloudRepoAdd.request(client, { path: projectRoot })).repo
  const { worktrees } = cloudWorktreeList.interpret(
    await cloudWorktreeList.request(client, { repo: `id:${repo.id}` })
  )
  // Never guess another checkout: an agent started in the wrong repository is worse than none.
  const main = worktrees.find((entry) => samePath(entry.path, repo.path))
  if (!main) {
    throw new Error('cloud_project_unavailable')
  }
  return main.id
}

export type CloudLaunchedAgent = {
  agent: string
  /** The terminal pane the agent runs in, when the host reports it (where its sign-in happens). */
  paneKey?: string
}

export async function launchCloudPrompt(
  client: UnvalidatedRpcRequestPort,
  worktreeId: string,
  prompt: Pick<QueuedCloudPrompt, 'agent' | 'text' | 'operationId'>
): Promise<CloudLaunchedAgent> {
  if (!isTuiAgent(prompt.agent)) {
    throw new Error('cloud_agent_unknown')
  }
  // The replay method dedupes by operation id in the host's durable ledger, so a resend after a
  // lost reply (or an app killed mid-send) never starts a second agent.
  const reply = await agentLaunchReplayRun.request(client, {
    agent: prompt.agent,
    operationId: prompt.operationId,
    target: { kind: 'existing', worktree: `id:${worktreeId}` },
    prompt: { text: prompt.text, delivery: 'submit' },
    launchSource: 'mobile'
  })
  const result = agentLaunchReplayRun.interpret(reply)
  const paneKey = result.outcome.kind === 'terminal' ? result.outcome.paneKey : undefined
  return { agent: prompt.agent, ...(paneKey ? { paneKey } : {}) }
}
