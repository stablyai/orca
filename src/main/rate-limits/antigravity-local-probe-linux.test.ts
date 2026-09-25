import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as fs from 'node:fs/promises'
import { probeLocalAntigravityLanguageServer } from './antigravity-local-probe'

const files = vi.hoisted(() => ({ readFile: vi.fn(), readdir: vi.fn(), readlink: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  ...files
}))

afterEach(() => vi.unstubAllGlobals())

describe('Antigravity Linux socket ownership', () => {
  it('resolves socket inodes to process fds before sending the token', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    files.readdir.mockImplementation(async (path: string) => {
      if (path === '/proc') {
        return ['1234', '9999']
      }
      return ['3']
    })
    files.readlink.mockImplementation(async (path: string) => {
      if (path === '/proc/1234/fd/3') {
        return 'socket:[100]'
      }
      if (path === '/proc/9999/fd/3') {
        return 'socket:[200]'
      }
      throw new Error('not available')
    })
    files.readFile.mockImplementation(async (path: string) => {
      if (path !== '/proc/net/tcp') {
        return ''
      }
      return [
        'sl local_address rem_address st tx_queue rx_queue tr tm retrnsmt inode',
        '0: 0100007F:1005 00000000:0000 0A 0:0 00:0 0 1000 0 100',
        '1: 0100007F:1006 00000000:0000 0A 0:0 00:0 0 1000 0 200',
        '2: 0100007F:1007 00000000:0000 0A 0:0 00:0 0 1000 0 300'
      ].join('\n')
    })
    const requestJson = vi.fn().mockResolvedValue({ status: 404, body: null })
    await probeLocalAntigravityLanguageServer({
      deps: {
        findProcess: async () => ({ pid: 1234, csrfToken: 'test-only-token' }),
        requestJson
      }
    })
    expect(files.readlink).toHaveBeenCalledWith('/proc/1234/fd/3')
    expect(requestJson).toHaveBeenCalledTimes(2)
    expect(requestJson.mock.calls.map(([options]) => options.port)).toEqual([4101, 4101])
  })
})
