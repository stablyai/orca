import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileWebNativeChatFileClient } from './mobile-web-native-chat-file-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

const payload = { workspaceId: 'workspace', sessionId: `native_chat_0_${'01'.repeat(16)}` }
function fixture() {
  const request = vi.fn(async (capability, operation, value) => {
    if (capability === 'nativeChat') {
      return operation === 'fileSearch' ? { paths: ['legacy.ts'] } : null
    }
    if (value.method.endsWith('.fileSearch')) {
      return {
        files: [
          { relativePath: 'src/main.ts' },
          { relativePath: '/private/file' },
          { relativePath: '../bad' }
        ],
        future: 1
      }
    }
    return { opened: true }
  })
  const requests = { supports: () => true, request } as unknown as MobileWebOneShotRequestClient
  return { request, client: new MobileWebNativeChatFileClient(requests) }
}
afterEach(() => vi.useRealTimers())
describe('native-chat file generic client', () => {
  it('searches in one host call and presents only valid relative paths', async () => {
    const f = fixture()
    expect(await f.client.fileSearch({ ...payload, query: 'src' }, 'tab')).toEqual({
      paths: ['src/main.ts']
    })
    expect(f.request.mock.calls.map((call) => call[2])).toEqual([
      {
        method: 'mobileWeb.nativeChat.fileSearch',
        workspaceId: 'workspace',
        timeoutMs: 15_000,
        params: {
          tabId: 'tab',
          sessionId: payload.sessionId,
          search: { query: 'src', limit: 16 }
        }
      }
    ])
  })

  it.each([
    ['fileSearch', () => fixture().client.fileSearch({ ...payload, query: 'src' }, undefined)],
    ['openFile', () => fixture().client.openFile({ ...payload, pathText: 'x' }, undefined)]
  ])('refuses %s without a tab to address', async (_name, run) => {
    await expect(run()).rejects.toMatchObject({ code: 'invalid_request' })
  })
  it('opens a file in one host call carrying the whole budget', async () => {
    const f = fixture()
    await expect(
      f.client.openFile({ ...payload, pathText: 'src/main.ts' }, 'tab')
    ).resolves.toBeNull()
    expect(
      f.request.mock.calls.map(
        (call) => ((call as unknown[]).at(-1) as { timeoutMs: number }).timeoutMs
      )
    ).toEqual([15_000])
    expect(f.request.mock.calls[0][2]).toEqual({
      method: 'mobileWeb.nativeChat.openFile',
      workspaceId: 'workspace',
      timeoutMs: 15_000,
      params: {
        tabId: 'tab',
        sessionId: payload.sessionId,
        pathText: 'src/main.ts',
        timeoutMs: 15_000
      }
    })
  })
  it.each(['timeout', 'host_error', 'unsupported_capability'] as const)(
    'never retries or falls back after the open dispatch reports %s',
    async (code) => {
      const f = fixture()
      f.request.mockImplementation(async () => {
        throw new MobileWebBridgeClientError(code, true)
      })
      await expect(f.client.openFile({ ...payload, pathText: 'x' }, 'tab')).rejects.toMatchObject({
        code
      })
      expect(f.request).toHaveBeenCalledOnce()
      expect(f.request.mock.calls.every((call) => call[0] === 'workspace')).toBe(true)
    }
  )
})
