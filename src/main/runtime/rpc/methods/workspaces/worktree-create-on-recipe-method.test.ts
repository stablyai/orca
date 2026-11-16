import '../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { readRuntimeMetadata } from '../../server/runtime-metadata'
import { OrcaRuntimeRpcServer } from '../../server/runtime-rpc'
import { RpcDispatcher } from '../../dispatcher'
import { sendRequest } from '../../../../../cli/runtime/connection/transport'
import type { RuntimeRpcProgress } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RecipeWorkspaceCreationHooks } from '../../../workspaces/sleep/runtime-workspace-sleep-operations'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { WORKTREE_CREATE_ON_RECIPE_RPC_METHOD } from './worktree-create-on-recipe-method'

const repo = {
  id: 'repo-1',
  path: '/src/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1
}
const params = { recipeId: 'fake-vm', repo: 'id:repo-1', name: 'fix-login' }
const created = {
  worktree: { id: 'vm-repo::/workspace/trees/fix-login' },
  host: {
    id: 'runtime:env-1',
    environmentId: 'env-1',
    runtimeId: 'vm-1',
    recipeId: 'fake-vm',
    checkoutMode: 'orca-worktree'
  }
}

const servers: OrcaRuntimeRpcServer[] = []
const sockets: Socket[] = []
const userDataPaths: string[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy()
  }
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  for (const path of userDataPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function desktopRuntime(create: RecipeWorkspaceCreationHooks['create']): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the repo it passes on.
  vi.spyOn(runtime, 'showRepo').mockResolvedValue(repo as unknown as Repo)
  runtime.setRecipeWorkspaceCreation({ create })
  return runtime
}

async function startServer(runtime: OrcaRuntimeService) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-recipe-create-rpc-'))
  userDataPaths.push(userDataPath)
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    methods: [WORKTREE_CREATE_ON_RECIPE_RPC_METHOD]
  })
  servers.push(server)
  await server.start()
  return readRuntimeMetadata(userDataPath)!
}

describe('worktree.createOnRecipe', () => {
  it("streams the desktop's progress to the CLI over the runtime socket, then answers", async () => {
    const runtime = desktopRuntime(async (_params, _repo, options) => {
      options.onProgress?.({ phase: 'running-create' })
      options.onProgress?.({ output: 'booting vm\n' })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transport forwards the result untouched.
      return created as never
    })
    const metadata = await startServer(runtime)
    const progress: RuntimeRpcProgress[] = []

    const response = await sendRequest(
      metadata,
      'worktree.createOnRecipe',
      params,
      30_000,
      undefined,
      undefined,
      { onProgress: (entry) => progress.push(entry) }
    )

    expect(response).toMatchObject({ ok: true, result: created })
    expect(progress).toEqual([{ phase: 'running-create' }, { output: 'booting vm\n' }])
  })

  it('aborts the create when the CLI disconnects mid-request', async () => {
    let aborted: (() => void) | undefined
    const abortSeen = new Promise<void>((resolve) => {
      aborted = resolve
    })
    const runtime = desktopRuntime(
      (_params, _repo, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              aborted?.()
              reject(new Error('cancelled'))
            },
            { once: true }
          )
          options.onProgress?.({ phase: 'running-create' })
        })
    )
    const metadata = await startServer(runtime)
    const socket = createConnection(metadata.transports[0]!.endpoint)
    sockets.push(socket)
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    // Ctrl+C: the CLI process exits as soon as the desktop reports the first step.
    socket.on('data', () => socket.destroy())
    socket.write(
      `${JSON.stringify({ id: 'create', authToken: metadata.authToken, method: 'worktree.createOnRecipe', params })}\n`
    )

    await expect(abortSeen).resolves.toBeUndefined()
  })

  it('refuses a paired device before anything is provisioned', async () => {
    const create = vi.fn()
    const dispatcher = new RpcDispatcher({
      runtime: desktopRuntime(create),
      methods: [WORKTREE_CREATE_ON_RECIPE_RPC_METHOD]
    })

    const response = await dispatcher.dispatch(
      { id: 'req-1', authToken: 'tok', method: 'worktree.createOnRecipe', params },
      {
        caller: { kind: 'paired-device', deviceId: 'laptop' },
        pairedDeviceId: 'laptop',
        callerScope: { kind: 'runtime-paired', grants: [] }
      }
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(create).not.toHaveBeenCalled()
  })
})
