import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { createAccumulator, finalizeSession } from './session-scanner-accumulator'
import type { SessionFileCandidate } from './session-scanner-types'
import type * as wslClientModule from './session-scanner-opencode-wsl-client'

const mocks = vi.hoisted(() => ({
  native: {
    list: vi.fn(async (): Promise<SessionFileCandidate[]> => []),
    parse: vi.fn(async () => null),
    capture: vi.fn(async () => ({ session: null, messages: [] }))
  },
  guest: vi.fn()
}))
vi.mock('./session-scanner-opencode-sqlite-worker-client', () => ({
  OpenCodeSqliteWorkerClient: class {
    list = mocks.native.list
    parse = mocks.native.parse
    capture = mocks.native.capture
  }
}))
vi.mock('./session-scanner-opencode-wsl-client', async (importOriginal) => ({
  ...(await importOriginal<typeof wslClientModule>()),
  openCodeWslClient: mocks.guest
}))
import {
  captureOpenCode2SqliteSessionViaWorker,
  captureOpenCodeSqliteSessionViaWorker,
  listOpenCode2SqliteSessionsViaWorker,
  listOpenCodeSqliteSessionsViaWorker,
  parseOpenCode2SqliteSessionViaWorker,
  parseOpenCodeSqliteSessionViaWorker
} from './session-scanner-opencode-sqlite-worker-spawn'

const ubuntu = '//wsl.localhost/Ubuntu/home/ada/opencode.db'
const debian = '//wsl$/Debian/home/ada/opencode.db'
const native = 'C:/Users/ada/opencode.db'
const guest = '/home/ada/opencode.db'

function row(path: string) {
  return {
    agent: 'opencode' as const,
    codexHome: null,
    file: { path: `${path}#same-session`, mtimeMs: 1, modifiedAt: new Date(1).toISOString() }
  }
}
function session() {
  const accumulator = createAccumulator({
    agent: 'opencode',
    sessionId: 'same-session',
    file: row(guest).file
  })
  accumulator.title = 'Session'
  accumulator.cwd = '/home/ada/repo'
  return finalizeSession(accumulator, 'linux')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
})
afterEach(() => vi.restoreAllMocks())

describe('OpenCode SQLite execution-host routes', () => {
  it('separates native and distro databases and preserves equal IDs in different distros', async () => {
    const list = vi.fn(async (args) => [row(args.dbPaths[0])])
    mocks.guest.mockResolvedValue({ list })
    mocks.native.list.mockResolvedValueOnce([row(native)])
    const issues: AiVaultScanIssue[] = []
    const result = await listOpenCodeSqliteSessionsViaWorker({
      dbPaths: [native, ubuntu, debian],
      limit: 2,
      issues
    })
    expect(result.map((entry) => entry.file.path)).toEqual([
      `${native}#same-session`,
      `${ubuntu}#same-session`,
      `${debian}#same-session`
    ])
    expect(mocks.native.list).toHaveBeenCalledWith(expect.objectContaining({ dbPaths: [native] }))
    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls.every(([args]) => args.dbPaths[0] === guest)).toBe(true)
    expect(mocks.guest).toHaveBeenNthCalledWith(1, 'Ubuntu', ubuntu, undefined)
    expect(mocks.guest).toHaveBeenNthCalledWith(2, 'Debian', debian, undefined)
    expect(issues).toEqual([])
  })

  it('maps guest list issues back to the original database and omits unavailable distros', async () => {
    mocks.guest
      .mockResolvedValueOnce({
        list: vi.fn(async (args) => {
          args.issues.push({ agent: 'opencode2', path: guest, message: 'locked' })
          return []
        })
      })
      .mockRejectedValueOnce(new Error('Distro stopped'))
    const issues: AiVaultScanIssue[] = []
    await listOpenCode2SqliteSessionsViaWorker({ dbPaths: [ubuntu, debian], limit: 2, issues })
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ubuntu, message: 'locked' }),
        expect.objectContaining({ path: debian, kind: 'scope', message: 'Distro stopped' })
      ])
    )
    expect(mocks.native.list).not.toHaveBeenCalled()
  })

  it.each([
    ['v1', parseOpenCodeSqliteSessionViaWorker, captureOpenCodeSqliteSessionViaWorker, undefined],
    [
      'v2',
      parseOpenCode2SqliteSessionViaWorker,
      captureOpenCode2SqliteSessionViaWorker,
      'opencode2'
    ]
  ] as const)(
    'routes %s parse/capture to Linux and restores the caller identity',
    async (_label, parse, capture, agent) => {
      const parsed = session()
      const messages = [{ role: 'user' as const, text: 'Complete transcript', timestamp: null }]
      const reader = {
        parse: vi.fn(async () => parsed),
        capture: vi.fn(async () => ({ session: parsed, messages }))
      }
      mocks.guest.mockResolvedValue(reader)
      const controller = new AbortController()
      const args = {
        dbPath: ubuntu,
        sessionId: 'same-session',
        platform: 'win32' as const,
        signal: controller.signal
      }
      expect(await parse({ ...args, fullFirstUserPrompt: true })).toMatchObject({
        id: `local:opencode:same-session:${ubuntu}`,
        filePath: ubuntu,
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`,
        executionHostPlatform: 'linux'
      })
      expect(reader.parse).toHaveBeenCalledWith({
        ...args,
        dbPath: guest,
        platform: 'linux',
        fullFirstUserPrompt: true,
        ...(agent ? { agent } : {})
      })
      expect(await capture(args)).toMatchObject({ session: { filePath: ubuntu }, messages })
      expect(reader.capture).toHaveBeenCalledWith({
        ...args,
        dbPath: guest,
        platform: 'linux',
        ...(agent ? { agent } : {})
      })
      expect(mocks.native.parse).not.toHaveBeenCalled()
      expect(mocks.native.capture).not.toHaveBeenCalled()
    }
  )

  it('propagates cancellation instead of returning an empty successful list', async () => {
    const controller = new AbortController()
    mocks.guest.mockImplementationOnce(async () => {
      controller.abort(new Error('cancelled'))
      throw new Error('cancelled')
    })
    await expect(
      listOpenCodeSqliteSessionsViaWorker({
        dbPaths: [ubuntu],
        limit: 1,
        issues: [],
        signal: controller.signal
      })
    ).rejects.toThrow('cancelled')
    expect(mocks.native.list).not.toHaveBeenCalled()
  })
})
