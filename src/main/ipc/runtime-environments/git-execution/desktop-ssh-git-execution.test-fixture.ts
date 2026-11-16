import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { KnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { SshTarget } from '../../../../shared/remote-runtime/ssh/ssh-types'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { Store } from '../../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { beginLocalCommandSelection } from '../../command-path/command-path-resolver'
import {
  installDesktopSshGitExecution,
  routeDesktopSshGitExecution
} from './desktop-ssh-git-execution'

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

export async function desktopGitHubCli(root: string, scriptContents: string) {
  const script = join(root, 'github-cli.cjs')
  const mutationLog = join(root, 'mutation.json')
  const executable = join(root, process.platform === 'win32' ? 'gh.cmd' : 'gh')
  await writeFile(script, scriptContents)
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(
    executable,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`,
    { mode: 0o755 }
  )
  vi.stubEnv('GH_TOKEN', 'desktop-gh-token')
  vi.stubEnv('ORCA_TEST_GH_LOG', mutationLog)
  const publish = beginLocalCommandSelection('gh')
  await publish(executable)
  return { mutationLog, dispose: () => publish(null) }
}

export function desktopWorkspaceRecords(
  checkoutPath: string,
  repositoryHostId: Repo['executionHostId'] = 'local'
) {
  const repo: Repo = {
    id: 'sandbox-project',
    path: checkoutPath,
    displayName: 'Shared project',
    badgeColor: '',
    addedAt: 0,
    ghAccount: { host: 'github.com', user: 'sandbox-account' },
    connectionId: repositoryHostId?.startsWith('ssh:') ? repositoryHostId.slice(4) : null,
    executionHostId: repositoryHostId
  }
  const worktree: Worktree = {
    id: `sandbox-project::${checkoutPath}`,
    repoId: repo.id,
    hostId: 'local',
    path: checkoutPath,
    head: '',
    branch: 'main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'Shared project',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  return { repo, worktree }
}

export function desktopRoute(
  checkoutPath: string,
  policy: Pick<SshTarget, 'gitExecution' | 'gitExecutionProjects'>,
  repositoryHostId: Repo['executionHostId'] = 'local',
  identity: { runtimeId?: string | null; currentRuntimeId?: string | null } = {}
) {
  const target: SshTarget = {
    id: 'sandbox',
    label: 'Sandbox',
    host: 'sandbox.test',
    port: 22,
    username: 'agent',
    generation: 1,
    orcadFence: { environmentId: 'sandbox-environment' },
    ...policy
  }
  const environment: KnownRuntimeEnvironment = {
    id: 'sandbox-environment',
    name: 'Sandbox',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    runtimeId: identity.runtimeId === undefined ? 'sandbox-runtime' : identity.runtimeId,
    endpoints: [
      {
        id: 'sandbox-endpoint',
        kind: 'websocket',
        label: 'SSH tunnel',
        endpoint: 'ws://127.0.0.1:9999',
        deviceToken: 'test-device-token',
        publicKeyB64: 'test-public-key'
      }
    ],
    preferredEndpointId: 'sandbox-endpoint',
    connectionDependency: 'ssh-tunnel',
    orcadDeployment: {
      sshTargetId: 'sandbox',
      sshTargetGeneration: 1,
      localPort: 9999,
      remotePort: 7777
    }
  }
  const { repo, worktree } = desktopWorkspaceRecords(checkoutPath, repositoryHostId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Git dispatch needs only the runtime ID; source-control execution is supplied by the production adapter.
  const runtime = { getRuntimeId: () => 'desktop-runtime' } as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this route reads only saved SSH targets; Git push never reads generation settings.
  const store = { getSshTargets: () => [target] } as Store
  installDesktopSshGitExecution(store, runtime)
  const readRemote = async (method: string): Promise<RuntimeRpcResponse<unknown>> => {
    const result =
      method === 'worktree.show'
        ? { worktree: { ...worktree, git: worktree } }
        : method === 'repo.show'
          ? { repo }
          : undefined
    if (!result) {
      throw new Error(`Sandbox must not execute ${method}`)
    }
    return { id: method, ok: true, result, _meta: { runtimeId: 'sandbox-runtime' } }
  }
  return (
    request: Partial<
      Pick<
        Parameters<typeof routeDesktopSshGitExecution>[0],
        'method' | 'params' | 'expectedPairingRevision'
      >
    > = {}
  ) =>
    routeDesktopSshGitExecution({
      environment,
      method: 'git.push',
      params: { worktree: `id:${worktree.id}`, publish: true },
      readRemote,
      getCurrentEnvironment:
        identity.currentRuntimeId === undefined
          ? undefined
          : async () => ({ ...environment, runtimeId: identity.currentRuntimeId ?? null }),
      ...request
    })
}
