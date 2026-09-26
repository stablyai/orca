import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { FILE_METHODS } from './files'
import { classifyRuntimeLongPoll } from '../../runtime-rpc/runtime-rpc-long-poll'

const request = {
  id: 'edit-1',
  authToken: 'token',
  method: 'files.edit',
  params: { filePath: '/tmp/prompt.txt', wait: true }
}

/** A minimal host keeps remote-refusal assertions at the real dispatcher boundary. */
function fixture() {
  const host = {
    getRuntimeId: () => 'test-runtime',
    editLocalFile: vi.fn(async () => ({ filePath: '/tmp/prompt.txt', closed: true }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The dispatcher and files.edit handler only call these two mocked host methods.
  const runtime = host as unknown as OrcaRuntimeService
  return { host, dispatcher: new RpcDispatcher({ runtime, methods: FILE_METHODS }) }
}

describe('files.edit RPC boundary', () => {
  it('passes the local disconnect signal through and reserves a long-poll slot', async () => {
    const { host, dispatcher } = fixture()
    const signal = new AbortController().signal
    const response = await dispatcher.dispatch(request, { signal })
    expect(response).toMatchObject({ ok: true, result: { closed: true } })
    expect(host.editLocalFile).toHaveBeenCalledWith('/tmp/prompt.txt', true, signal)
    expect(classifyRuntimeLongPoll(request)).toBe('editor')
  })

  it.each(['mobile', 'runtime'] as const)(
    'refuses %s peers before opening or authorizing a path',
    async (clientKind) => {
      const { host, dispatcher } = fixture()
      const response = await dispatcher.dispatch(request, { clientKind })
      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('local desktop') }
      })
      expect(host.editLocalFile).not.toHaveBeenCalled()
    }
  )

  it('also refuses an identified remote connection without a client kind', async () => {
    const { host, dispatcher } = fixture()
    expect(await dispatcher.dispatch(request, { connectionId: 'remote-1' })).toMatchObject({
      ok: false
    })
    expect(host.editLocalFile).not.toHaveBeenCalled()
  })
})
