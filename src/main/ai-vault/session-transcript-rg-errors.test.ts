import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAiVaultTestSession } from '../../shared/ai-vault-session-test-session'

vi.mock('../git/runner', () => ({
  wslAwareSpawn: vi.fn()
}))

vi.mock('../ipc/rg-availability', () => ({
  checkRgAvailable: vi.fn()
}))

const { wslAwareSpawn } = await import('../git/runner')
const { checkRgAvailable } = await import('../ipc/rg-availability')
const { searchAiVaultSessionsWithRg } = await import('./session-transcript-rg')

const spawnMock = vi.mocked(wslAwareSpawn)
const rgAvailableMock = vi.mocked(checkRgAvailable)

function createFakeRgChild(options: {
  code?: number | null
  error?: Error
  stdout?: string
}): ReturnType<typeof wslAwareSpawn> {
  const stdout = Object.assign(new EventEmitter(), {
    setEncoding: (): void => undefined
  })
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: { resume: (): void => undefined },
    kill: vi.fn()
  })
  queueMicrotask(() => {
    if (options.error) {
      child.emit('error', options.error)
      return
    }
    if (options.stdout) {
      stdout.emit('data', options.stdout)
    }
    child.emit('close', options.code ?? 0)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: EventEmitter stand-in implements the spawn surface session rg reads (stdout/stderr/kill/close/error).
  return child as never
}

const filePath = '/tmp/ai-vault-session.jsonl'
const session = createAiVaultTestSession({
  id: 'claude:1',
  title: 'Linux pairing',
  filePath
})
const sessionsById = new Map([[session.id, session]])
const searchArgs = {
  query: 'pairing',
  searchScope: 'full' as const,
  sessionIds: [session.id]
}

describe('searchAiVaultSessionsWithRg spawn errors', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    rgAvailableMock.mockReset()
    rgAvailableMock.mockResolvedValue(true)
  })

  it('treats rg exit 1 as no matches and still reports usedRg', async () => {
    spawnMock.mockImplementation(() => createFakeRgChild({ code: 1 }))

    await expect(searchAiVaultSessionsWithRg(searchArgs, sessionsById)).resolves.toMatchObject({
      matchedIds: [],
      usedRg: true,
      usedFts: false,
      truncated: false
    })
  })

  it('does not claim usedRg when rg exits with an error code', async () => {
    spawnMock.mockImplementation(() => createFakeRgChild({ code: 2 }))

    await expect(searchAiVaultSessionsWithRg(searchArgs, sessionsById)).resolves.toMatchObject({
      matchedIds: [],
      usedRg: false,
      usedFts: false,
      truncated: false
    })
  })

  it('does not claim usedRg when rg fails to spawn', async () => {
    spawnMock.mockImplementation(() => createFakeRgChild({ error: new Error('ENOENT') }))

    await expect(searchAiVaultSessionsWithRg(searchArgs, sessionsById)).resolves.toMatchObject({
      matchedIds: [],
      usedRg: false,
      usedFts: false,
      truncated: false
    })
  })

  it('returns matching session ids when rg exits 0', async () => {
    spawnMock.mockImplementation(() => createFakeRgChild({ code: 0, stdout: `${filePath}\n` }))

    await expect(searchAiVaultSessionsWithRg(searchArgs, sessionsById)).resolves.toMatchObject({
      matchedIds: ['claude:1'],
      usedRg: true,
      usedFts: false,
      truncated: false
    })
  })
})
