import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import { routeTaskRepoCalls } from './task-repo-host-routing'
import type { ActionableTaskItem, RepoSummary } from './mobile-tasks-legacy-foundation'
import type { WorkspaceSparseActionsModel } from './use-mobile-tasks-workspace-sparse-actions'

vi.mock('./mobile-tasks-dependencies', async () => {
  const react = await import('react')
  return {
    useCallback: react.useCallback,
    useEffect: react.useEffect,
    useMemo: react.useMemo,
    ...(await import('./workspace-agent-selection')),
    ...(await import('./setup-hook-trust')),
    ...(await import('./workspace-create-params')),
    ...(await import('./hosted-review-start-point')),
    ...(await import('./workspace-create-timeout'))
  }
})

const { useMobileTasksWorkspaceSshState } = await import('./use-mobile-tasks-workspace-ssh-state')
const { useMobileTasksWorkspaceCreateActions } =
  await import('./use-mobile-tasks-workspace-create-actions')

type Sent = { method: string; params?: unknown; executionHost?: string }
const sentBy = new WeakMap<FakeSession, Sent[]>()

function recording(
  client: FakeSession,
  answer: (method: string, executionHost: string | undefined) => Promise<RpcResponse>
): FakeSession {
  const sent: Sent[] = []
  sentBy.set(client, sent)
  client.sendRequest.mockImplementation(
    async (
      method: string,
      params?: unknown,
      options?: { envelope?: { executionHost?: string } }
    ) => {
      sent.push({ method, params, executionHost: options?.envelope?.executionHost })
      return answer(method, options?.envelope?.executionHost)
    }
  )
  return client
}

function reply(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

const SERVER_REPO: RepoSummary = {
  id: 'vm-repo',
  displayName: 'api',
  path: '/srv/api',
  executionHostId: 'runtime:vm'
}
const DESKTOP_REPO: RepoSummary = { id: 'mac-repo', displayName: 'app', path: '/mac/app' }

function issueOn(repo: RepoSummary): ActionableTaskItem {
  return {
    key: `github:${repo.id}:issue:7`,
    provider: 'github',
    title: 'Fix the thing',
    subtitle: '',
    status: 'Open',
    updatedAt: '2026-10-11T00:00:00Z',
    source: {
      id: 'issue:7',
      type: 'issue',
      number: 7,
      title: 'Fix the thing',
      state: 'open',
      url: 'https://github.com/o/r/issues/7',
      labels: [],
      updatedAt: '2026-10-11T00:00:00Z',
      author: null,
      repoId: repo.id,
      repoName: repo.displayName
    }
  }
}

function desktop(): FakeSession {
  return recording(new FakeSession('connected'), async (method) => {
    if (method === 'worktree.create') {
      return reply({ worktree: { id: 'wt-1', displayName: 'fix-the-thing' } })
    }
    return reply(method === 'preflight.detectAgents' ? [] : {})
  })
}

function ranOn(client: FakeSession, method: string): string[] {
  return (sentBy.get(client) ?? [])
    .filter((sent) => sent.method === method)
    .map((sent) => sent.executionHost ?? 'desktop')
}

const mounted: ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount())
  }
})

async function createFrom(repo: RepoSummary) {
  const client = desktop()
  const pushed: string[] = []
  const item = issueOn(repo)
  const noop = () => {}
  const model = {
    client: routeTaskRepoCalls(client, () => [DESKTOP_REPO, SERVER_REPO]),
    hostId: 'mac',
    router: { push: (href: string) => pushed.push(href) },
    runtimeTaskSettings: {},
    tasksSupported: true,
    taskStateHydrated: true,
    trustedOrcaHooks: {},
    workspaceAgent: 'blank',
    workspaceAgentOverridden: true,
    workspaceCreateDraft: { item },
    workspaceCreateRequiresSshConnection: false,
    workspaceCreateSshStatus: 'connected',
    workspaceCreateTargetConnectionId: null,
    workspaceCreateTargetRepo: repo,
    workspaceDetectedAgentIds: null,
    workspaceLastAutoName: '',
    workspaceSshState: null,
    getWorkspaceTargetRepo: () => repo,
    setActionItem: noop,
    setCreatingKey: noop,
    setError: noop,
    setOrcaYamlTrustPrompt: noop,
    setRuntimeTaskSettings: noop,
    setSetupPrompt: noop,
    setWorkspaceAgent: noop,
    setWorkspaceAgentOverridden: noop,
    setWorkspaceCreateDraft: noop,
    setWorkspaceDetectedAgentIds: noop,
    setWorkspaceSshConnecting: noop,
    setWorkspaceSshState: noop
  }
  const seen: { create?: ReturnType<typeof useMobileTasksWorkspaceCreateActions> } = {}
  function Harness(): null {
    seen.create = useMobileTasksWorkspaceCreateActions(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model carries every member these two stages read.
      useMobileTasksWorkspaceSshState({ ...model } as unknown as WorkspaceSparseActionsModel)
    )
    return null
  }
  await act(async () => {
    mounted.push(create(createElement(Harness)))
  })
  await act(async () => {
    await seen.create!.createWorkspace(item, undefined, undefined, 'blank')
  })
  return { client, pushed }
}

describe('creating a workspace from a task on a server repo', () => {
  it('creates it on that server, detects agents there, and opens it there', async () => {
    const { client, pushed } = await createFrom(SERVER_REPO)
    expect(ranOn(client, 'worktree.create')).toEqual(['runtime:vm'])
    expect(ranOn(client, 'preflight.detectAgents')).toEqual(['runtime:vm'])
    expect(
      sentBy.get(client)?.find((sent) => sent.method === 'preflight.detectAgents')?.params
    ).toEqual({ repoId: SERVER_REPO.id })
    expect(pushed).toHaveLength(1)
    expect(new URL(pushed[0]!, 'orca://x').searchParams.get('executionHost')).toBe('runtime:vm')
  })

  it("keeps a desktop repo's workspace on the desktop", async () => {
    const { client, pushed } = await createFrom(DESKTOP_REPO)
    expect(ranOn(client, 'worktree.create')).toEqual(['desktop'])
    expect(ranOn(client, 'preflight.detectAgents')).toEqual(['desktop'])
    expect(
      sentBy.get(client)?.find((sent) => sent.method === 'preflight.detectAgents')?.params
    ).toEqual({ repoId: DESKTOP_REPO.id })
    expect(new URL(pushed[0]!, 'orca://x').searchParams.get('executionHost')).toBeNull()
  })
})
