import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { FILE_MUTATION_METHODS } from './files-mutation-methods'

describe.each([
  ['files.writeBase64', 'writeFileExplorerFileBase64'],
  ['files.writeBase64Chunk', 'writeFileExplorerFileBase64Chunk']
] as const)('%s base64 padding', (method, runtimeMethod) => {
  it.each([
    ['A=', false],
    ['AA=', false],
    ['A==', false],
    ['==', false],
    ['AAAAA=', false],
    ['AAAAAA=', false],
    ['AAAAA==', false],
    ['AAAA==', false],
    ['AA==', true],
    ['AAA=', true],
    ['AAAA', true],
    ['', true],
    ['A', false],
    ['AA=A', false],
    ['AA', true],
    ['AAA', true]
  ])('validates %j before writing (accepted: %s)', async (contentBase64, accepted) => {
    const write = vi.fn().mockResolvedValue({ ok: true })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      [runtimeMethod]: write
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_MUTATION_METHODS })

    const response = await dispatcher.dispatch({
      id: 'padding',
      authToken: 'tok',
      method,
      params: {
        worktree: 'id:wt-1',
        relativePath: 'upload.bin',
        contentBase64,
        append: true
      }
    })

    expect(response).toMatchObject({ ok: accepted })
    expect(write).toHaveBeenCalledTimes(accepted ? 1 : 0)
    if (accepted) {
      expect(write).toHaveBeenCalledWith(
        'id:wt-1',
        'upload.bin',
        contentBase64,
        ...(method === 'files.writeBase64Chunk' ? [true] : [])
      )
    }
  })
})
