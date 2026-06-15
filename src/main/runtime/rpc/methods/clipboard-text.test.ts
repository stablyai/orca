import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'

const { electronClipboard } = vi.hoisted(() => ({
  electronClipboard: {
    readText: vi.fn(),
    writeText: vi.fn()
  }
}))

vi.mock('electron', () => ({
  clipboard: electronClipboard
}))

import { CLIPBOARD_METHODS, MAX_CLIPBOARD_TEXT_BYTES } from './clipboard'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeDispatcher(): RpcDispatcher {
  const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: CLIPBOARD_METHODS })
}

describe('clipboard text RPC methods', () => {
  beforeEach(() => {
    electronClipboard.readText.mockReset()
    electronClipboard.writeText.mockReset()
  })

  it('reads available host clipboard text', async () => {
    electronClipboard.readText.mockReturnValue('from desktop')
    const dispatcher = makeDispatcher()

    const response = await dispatcher.dispatch(makeRequest('clipboard.readText', null))

    expect(response).toMatchObject({
      ok: true,
      result: { available: true, text: 'from desktop' }
    })
    expect(electronClipboard.readText).toHaveBeenCalledTimes(1)
  })

  it('reports empty host clipboard text as unavailable', async () => {
    electronClipboard.readText.mockReturnValue('')
    const dispatcher = makeDispatcher()

    const response = await dispatcher.dispatch(makeRequest('clipboard.readText', null))

    expect(response).toMatchObject({
      ok: true,
      result: { available: false, text: '' }
    })
  })

  it('writes mobile clipboard text to the host clipboard', async () => {
    const dispatcher = makeDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('clipboard.writeText', { text: 'from phone' })
    )

    expect(response).toMatchObject({ ok: true, result: { written: true } })
    expect(electronClipboard.writeText).toHaveBeenCalledWith('from phone')
  })

  it('rejects oversized mobile clipboard text before writing', async () => {
    const dispatcher = makeDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('clipboard.writeText', { text: 'a'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1) })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: 'Clipboard text is too large' }
    })
    expect(electronClipboard.writeText).not.toHaveBeenCalled()
  })

  it('rejects oversized host clipboard text before returning it', async () => {
    electronClipboard.readText.mockReturnValue('a'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1))
    const dispatcher = makeDispatcher()

    const response = await dispatcher.dispatch(makeRequest('clipboard.readText', null))

    expect(response).toMatchObject({
      ok: false,
      error: { message: 'Clipboard text is too large' }
    })
  })
})
