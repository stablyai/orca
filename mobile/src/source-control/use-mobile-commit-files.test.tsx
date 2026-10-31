import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { useMobileCommitFiles, type MobileCommitFilesState } from './use-mobile-commit-files'

const FILES: RpcResponse = {
  id: 'compare',
  ok: true,
  result: {
    summary: { commitOid: 'c1', parentOid: 'p1' },
    entries: [{ path: 'src/app.ts', added: 3, removed: 1 }]
  }
}
const REFUSED: RpcResponse = {
  id: 'compare',
  ok: false,
  error: { code: 'runtime_error', message: 'Unable to read commit' }
}

describe('useMobileCommitFiles', () => {
  let renderer: ReactTestRenderer | null = null
  let latest: MobileCommitFilesState | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Harness(props: { client: RpcClient; connState: ConnectionState }) {
    latest = useMobileCommitFiles({ ...props, worktreeId: 'wt-1', commitId: 'c1' })
    return null
  }

  async function render(client: RpcClient, connState: ConnectionState): Promise<void> {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(Harness, { client, connState }))
      } else {
        renderer = create(createElement(Harness, { client, connState }))
      }
      await Promise.resolve()
    })
  }

  it('waits for the connection instead of reading an outage as a commit with no files', async () => {
    const sendRequest = vi.fn().mockResolvedValue(FILES)
    const client = { sendRequest } as unknown as RpcClient

    await render(client, 'disconnected')
    expect(sendRequest).not.toHaveBeenCalled()
    expect(latest?.files).toBeNull()
    expect(latest?.error).toBeNull()

    await render(client, 'connected')
    expect(sendRequest).toHaveBeenCalledWith('git.commitCompare', {
      worktree: 'id:wt-1',
      commitId: 'c1'
    })
    expect(latest?.files?.map((file) => file.path)).toEqual(['src/app.ts'])
    expect(latest?.parentOid).toBe('p1')
  })

  it('keeps the files it showed when a refresh is refused, and offers the refusal for retry', async () => {
    const sendRequest = vi.fn().mockResolvedValueOnce(FILES).mockResolvedValueOnce(REFUSED)
    const client = { sendRequest } as unknown as RpcClient

    await render(client, 'connected')
    await act(async () => {
      latest?.reload()
      await Promise.resolve()
    })
    expect(latest?.files?.map((file) => file.path)).toEqual(['src/app.ts'])
    expect(latest?.error).toBe('Unable to read commit')
  })
})
