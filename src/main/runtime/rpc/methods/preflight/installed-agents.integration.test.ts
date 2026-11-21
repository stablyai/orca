import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../../../../cli/index'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { defineMethod, type RpcRequest } from '../../core'
import { PREFLIGHT_METHODS } from './preflight'
import { WorktreeShow } from '../../../../../shared/rpc-contract/workspaces/worktree-params'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { getRuntimeMetadataPath } from '../../../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import * as detection from '../../../../preflight/workspace-agent-detection'
import {
  clearSshHostServerStatus,
  setSshHostServerStatus
} from '../../../../ssh/host-server/ssh-host-server-status'

const roots: string[] = []
const sockets = new Set<Socket>()
const servers = new Set<ReturnType<typeof createServer>>()

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  clearSshHostServerStatus('box')
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  servers.clear()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function runtimeFor(hostId: ExecutionHostId, workspaceId: string, owner = false) {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('test')
  const path = '/srv/app'
  const repo = { id: 'repo', path, executionHostId: hostId }
  const folder = {
    id: 'hub',
    folderPath: path,
    executionHostId: hostId,
    projectGroupId: 'group'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: detection reads only the supplied catalog and settings methods.
  vi.spyOn(runtime, 'requireStore').mockReturnValue({
    getRepos: () => [repo],
    getProjects: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [folder],
    getSettings: () => ({
      disabledTuiAgents: owner ? ['gemini'] : ['codex'],
      defaultTuiAgent: owner ? 'codex' : 'claude',
      agentCmdOverrides: owner ? { codex: '/owner/codex' } : {}
    })
  } as never)
  vi.spyOn(runtime, 'resolveAgentDetectionHost').mockResolvedValue({ kind: 'local' })
  vi.spyOn(runtime, 'showManagedWorktree').mockImplementation(async (_selector, requiredHostId) => {
    if (requiredHostId && requiredHostId !== hostId) {
      throw new Error('selector_not_found')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture provides every workspace field detection and CLI selection read.
    return { id: workspaceId, hostId, repoId: 'repo', path } as never
  })
  return runtime
}

function dispatcherFor(runtime: OrcaRuntimeService) {
  return new RpcDispatcher({
    runtime,
    methods: [
      ...PREFLIGHT_METHODS,
      defineMethod({
        name: 'worktree.show',
        permission: 'workspace',
        params: WorktreeShow,
        handler: async (params) => ({
          worktree: await runtime.showManagedWorktree(params.worktree, undefined, {
            matchFolders: params.matchFolderWorkspaces
          })
        })
      })
    ]
  })
}

async function connectCli(dispatcher: RpcDispatcher) {
  const root = mkdtempSync(join(tmpdir(), 'orca-installed-'))
  roots.push(root)
  const endpoint = join(root, 'runtime.sock')
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request: RpcRequest = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        void dispatcher.dispatch(request).then((response) => {
          socket.write(`${JSON.stringify(response)}\n`)
        })
      }
    })
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  writeFileSync(
    getRuntimeMetadataPath(root),
    JSON.stringify({
      runtimeId: 'test',
      pid: process.pid,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'test',
      startedAt: 1
    })
  )
  for (const key of Object.keys(process.env).filter((key) => key.startsWith('ORCA_'))) {
    vi.stubEnv(key, '')
  }
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
}

describe.skipIf(process.platform === 'win32')('agent installed over CLI RPC', () => {
  it.each([
    ['ssh:box', 'repo::/srv/app'],
    ['runtime:owner', 'folder:hub'],
    ['local', 'repo::/srv/app']
  ] as const)('reads agents and launch settings on %s for %s', async (host, workspaceId) => {
    const owner = runtimeFor('local', workspaceId, true)
    const runtime = host === 'local' ? owner : runtimeFor(host, workspaceId)
    const ownerDispatcher = dispatcherFor(owner)
    setSshHostServerStatus('box', { kind: 'managed', environmentId: 'owner' })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockResolvedValue({
      environmentId: 'owner',
      name: 'Owner',
      peerFingerprint: 'owner',
      pairingRevision: 7
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_environment, method, params) => {
        const response = await ownerDispatcher.dispatch({
          id: 'owner',
          authToken: '',
          method,
          params
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        return response.result
      }
    )
    vi.spyOn(detection, 'detectAgentsOnHost').mockImplementation(async (_host, options) =>
      options?.agentCmdOverrides?.codex === '/owner/codex' ? ['codex', 'gemini'] : ['claude']
    )
    await connectCli(dispatcherFor(runtime))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['agent', 'installed', '--worktree', `id:${workspaceId}`, '--json'], '/client')

    expect(JSON.parse(log.mock.calls[0][0]).result.agents).toEqual([
      { id: 'codex', name: 'Codex', default: true }
    ])
  })

  it('refuses an unserved SSH workspace instead of reporting client agents', async () => {
    const runtime = runtimeFor('ssh:box', 'repo::/srv/app')
    await connectCli(dispatcherFor(runtime))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const previousExit = process.exitCode
    try {
      await main(['agent', 'installed', '--worktree', 'id:repo::/srv/app', '--json'], '/client')
      expect(JSON.parse(log.mock.calls[0][0]).error.code).toBe('runtime_error')
    } finally {
      process.exitCode = previousExit
    }
  })

  it('reports an older execution owner as incompatible', async () => {
    const runtime = runtimeFor('runtime:owner', 'repo::/srv/app')
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockResolvedValue({
      environmentId: 'owner',
      name: 'Owner',
      peerFingerprint: 'owner',
      pairingRevision: 7
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockRejectedValue(
      new OrchestrationError('method_not_found', 'Unknown method: preflight.installedAgents')
    )
    await connectCli(dispatcherFor(runtime))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const previousExit = process.exitCode
    try {
      await main(['agent', 'installed', '--worktree', 'id:repo::/srv/app', '--json'], '/client')
      expect(JSON.parse(log.mock.calls[0][0]).error.code).toBe('incompatible_runtime')
    } finally {
      process.exitCode = previousExit
    }
  })

  it('refuses a forwarded lookup whose returned owner is not local', async () => {
    const runtime = runtimeFor('runtime:back', 'repo::/srv/app')
    const worktree = await runtime.showManagedWorktree('id:repo::/srv/app')
    vi.mocked(runtime.showManagedWorktree).mockResolvedValue(worktree)
    const response = await dispatcherFor(runtime).dispatch({
      id: 'forwarded',
      authToken: '',
      method: 'preflight.installedAgents',
      params: { worktreeId: 'repo::/srv/app', worktreeHostId: 'local' }
    })
    expect(response).toMatchObject({
      ok: false,
      error: { message: 'worktree_execution_host_unresolved' }
    })
  })
})
