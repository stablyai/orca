import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { chooseSessionDiffOpen, openSessionChangedFile } from './session-changed-file-open'

function failure(code: string, message: string): RpcResponse {
  return { id: 'request-1', ok: false, error: { code, message } }
}

function success(result: unknown): RpcResponse {
  return { id: 'request-1', ok: true, result }
}

function clientReplying(replies: RpcResponse[]) {
  const send = vi.fn(async () => replies.shift())
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the opener only sends requests through this client.
  return { client: { sendRequest: send } as unknown as RpcClient, send }
}

const ARGS = { worktreeId: 'wt-1', relativePath: 'src/app.ts', staged: false }

describe('chooseSessionDiffOpen', () => {
  it('renders on the device when the host has no renderer to open a tab (#14315)', () => {
    expect(chooseSessionDiffOpen(failure('runtime_error', 'renderer_unavailable'))).toBe(
      'device-review'
    )
  })

  it('keeps the edit-tab fallback for a host too old to open diff tabs', () => {
    expect(chooseSessionDiffOpen(failure('method_not_found', 'files.openDiff'))).toBe('edit-tab')
  })

  it('leaves other replies to the diff-tab interpretation', () => {
    expect(chooseSessionDiffOpen(success({ opened: true }))).toBe('diff-tab')
    expect(chooseSessionDiffOpen(failure('runtime_error', 'file_not_found'))).toBe('diff-tab')
  })
})

describe('openSessionChangedFile', () => {
  it('opens a diff tab on a host with a renderer', async () => {
    const { client, send } = clientReplying([success({ opened: true })])

    await expect(openSessionChangedFile(client, ARGS)).resolves.toBe('diff')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('hands a headless host’s refusal to the device renderer without a second request', async () => {
    const { client, send } = clientReplying([failure('runtime_error', 'renderer_unavailable')])

    await expect(openSessionChangedFile(client, ARGS)).resolves.toBe('device-review')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('falls back to an edit tab on an old host, and to the device when that also cannot open', async () => {
    const old = clientReplying([failure('method_not_found', 'x'), success({ opened: true })])
    await expect(openSessionChangedFile(old.client, ARGS)).resolves.toBe('edit')

    const headlessOld = clientReplying([
      failure('method_not_found', 'x'),
      failure('runtime_error', 'renderer_unavailable')
    ])
    await expect(openSessionChangedFile(headlessOld.client, ARGS)).resolves.toBe('device-review')
  })

  it('surfaces any other refusal as the host message', async () => {
    const { client } = clientReplying([failure('runtime_error', 'file_not_found')])

    await expect(openSessionChangedFile(client, ARGS)).rejects.toThrow('file_not_found')
  })
})
