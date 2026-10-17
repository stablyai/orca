import '../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { FILE_MUTATION_METHODS } from './files-mutation-methods'

it.each(['files.writeBase64Chunk', 'files.commitUpload'])(
  'validates and forwards the existing-parent policy for %s',
  async (method) => {
    const write = vi.fn().mockResolvedValue({ ok: true })
    const surface = {
      getRuntimeId: () => 'runtime-test',
      writeFileExplorerFileBase64Chunk: write,
      commitFileExplorerUpload: write
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these RPC methods only call the two supplied commands and getRuntimeId.
    const runtime = surface as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_MUTATION_METHODS })
    const params = {
      worktree: 'folder:notes',
      relativePath: 'image.png',
      contentBase64: 'AA==',
      append: true,
      tempRelativePath: '.image.tmp',
      finalRelativePath: 'image.png',
      expectedExecutionHostId: 'local',
      requireExistingParent: true
    }
    expect(
      await dispatcher.dispatch({ id: 'strict', authToken: 'tok', method, params })
    ).toMatchObject({ ok: true })
    expect(write).toHaveBeenCalledWith(
      'folder:notes',
      ...(method === 'files.commitUpload'
        ? ['.image.tmp', 'image.png']
        : ['image.png', 'AA==', true]),
      undefined,
      undefined,
      'local',
      true
    )
    write.mockClear()
    expect(
      await dispatcher.dispatch({
        id: 'invalid',
        authToken: 'tok',
        method,
        params: { ...params, requireExistingParent: 'true' }
      })
    ).toMatchObject({ ok: false })
    expect(write).not.toHaveBeenCalled()
  }
)
