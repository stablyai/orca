import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeFileCommands } from './orca-runtime-files'
import { RpcDispatcher } from './rpc/dispatcher'
import { FILE_METHODS } from './rpc/methods/files'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { pathsExistOnRelay } from '../../relay/fs-path-existence'
import { statRelayPath } from '../../relay/fs-path-metadata-requests'
let root: string | undefined
const connection = 'batch-fixture-host'
afterEach(async () => {
  unregisterSshFilesystemProvider(connection)
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
})
async function setup(legacy = false) {
  root = await mkdtemp(join(tmpdir(), 'orca-runtime-batch-'))
  const names = Array.from({ length: 8 }, (_, i) => `file-${i}.ts`)
  await Promise.all(names.map((name) => writeFile(join(root!, name), 'fixture')))
  const provider = {
    pathsExist: legacy
      ? undefined
      : vi.fn((paths: string[]) => pathsExistOnRelay({ filePaths: paths })),
    stat: vi.fn((filePath: string) => statRelayPath({ filePath }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The registered fixture implements the stat and optional batch operations exercised here.
  registerSshFilesystemProvider(connection, provider as never)
  const resolveTarget = vi.fn(async () => ({
    worktree: { id: 'folder-1', path: root, kind: 'folder', repoId: 'folder-repo' },
    executionHostId: `ssh:${connection}`
  }))
  const host = {
    getRuntimeId: () => 'runtime-fixture',
    requireStore: vi.fn(() => {
      throw new Error('Local store should not be read')
    }),
    resolveRuntimeFileTarget: resolveTarget
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies runtime identity, target resolution and the guarded store accessor used by these reads.
  const commands = new RuntimeFileCommands(host as never)
  const runtime = {
    getRuntimeId: host.getRuntimeId,
    pathsExistRuntimeFiles: commands.pathsExistRuntimeFiles.bind(commands),
    statRuntimeFile: commands.statRuntimeFile.bind(commands)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Dispatch is limited to the two file methods implemented by this fixture.
  const dispatcher = new RpcDispatcher({ runtime: runtime as never, methods: FILE_METHODS })
  const dispatch = (relativePaths: string[]) =>
    dispatcher.dispatch({
      id: 'batch-1',
      authToken: 'fixture',
      method: 'files.pathsExist',
      params: { worktree: 'id:folder-1', relativePaths }
    })
  return { names, provider, resolveTarget, host, dispatch }
}
it('actual RPC dispatch resolves one folder owner and sends one provider batch for eight real files', async () => {
  const f = await setup()
  expect(await f.dispatch(f.names)).toMatchObject({
    ok: true,
    result: f.names.map(() => ({ exists: true }))
  })
  expect(f.resolveTarget).toHaveBeenCalledTimes(1)
  expect(f.resolveTarget).toHaveBeenCalledWith('id:folder-1')
  expect(f.provider.pathsExist).toHaveBeenCalledTimes(1)
  expect(f.provider.stat).not.toHaveBeenCalled()
  expect(f.host.requireStore).not.toHaveBeenCalled()
  expect(await f.dispatch(['../escape'])).toMatchObject({ ok: false })
  expect(f.provider.pathsExist).toHaveBeenCalledTimes(1)
})
it('legacy provider preserves all answers through scoped scalar stats', async () => {
  const f = await setup(true)
  expect(await f.dispatch([...f.names, 'missing'])).toMatchObject({
    ok: true,
    result: [...f.names.map(() => ({ exists: true })), { exists: false }]
  })
  expect(f.provider.stat).toHaveBeenCalledTimes(9)
  expect(f.host.requireStore).not.toHaveBeenCalled()
})
it('unavailable SSH never falls back to matching local files; oversized input never reaches provider', async () => {
  const f = await setup()
  unregisterSshFilesystemProvider(connection)
  expect(await f.dispatch(f.names)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('Remote connection dropped') }
  })
  expect(f.host.requireStore).not.toHaveBeenCalled()
  expect(await f.dispatch(Array(129).fill('file-0.ts'))).toMatchObject({ ok: false })
  expect(f.provider.pathsExist).not.toHaveBeenCalled()
})
