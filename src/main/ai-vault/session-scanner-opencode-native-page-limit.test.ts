import { describe, expect, it, vi } from 'vitest'

const readNativeChat = vi.hoisted(() =>
  vi.fn(async () => ({ items: [], hasMore: false, beforeMessageRowId: null }))
)
vi.mock('./session-scanner-opencode-sqlite-worker-client', () => ({
  OpenCodeSqliteWorkerClient: class {
    readNativeChat = readNativeChat
  }
}))
vi.mock('./session-scanner-opencode-wsl-client', () => ({
  openCodeWslPath: (path: string) =>
    path.startsWith('wsl:') ? { distro: 'Ubuntu', linuxPath: '/home/test/opencode.db' } : null,
  openCodeWslClient: async () => ({ readNativeChat }),
  mapOpenCodeWslSession: (value: unknown) => value
}))
import { readOpenCodeTranscriptPageViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'

describe.each(['native.db', 'wsl:opencode.db'])('native-page protocol bounds for %s', (dbPath) => {
  it.each([
    [10.9, 10],
    [0, 1],
    [-1, 1],
    [0.1, 1],
    [2401, 2400],
    [Number.MAX_VALUE, 2400],
    [Number.MAX_SAFE_INTEGER + 1, 2400],
    [Number.NaN, 300],
    [Infinity, 300],
    [-Infinity, 300]
  ])(
    'normalizes %s to a finite safe page limit of %s before transport',
    async (limit, expected) => {
      await readOpenCodeTranscriptPageViaWorker({ dbPath, sessionId: 'session', limit })
      expect(readNativeChat).toHaveBeenLastCalledWith(
        {
          kind: 'native-page',
          dbPath: dbPath.startsWith('wsl:') ? '/home/test/opencode.db' : dbPath,
          sessionId: 'session',
          limit: expected
        },
        undefined
      )
    }
  )
})
