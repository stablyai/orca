import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopChatCreationHistory } from './desktop-chat-creation-history'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof NodeFs>()
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) }
})
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof NodeFsPromises>()
  return { ...fs, writeFile: vi.fn(fs.writeFile), rename: vi.fn(fs.rename) }
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
function root() {
  const value = mkdtempSync(join(tmpdir(), 'pr-28978-creation-history-'))
  roots.push(value)
  return value
}

it('retains minting facts across launches and aliases until their environment is removed', async () => {
  const path = root()
  const history = new DesktopChatCreationHistory(path)
  await history.recordCreate('ssh', 'agentSession.create', { envelope: { sessionId: 'old-chat' } })
  await history.recordCreate('wsl', 'agentSession.create', { envelope: { sessionId: 'new-chat' } })
  await history.recordCreate('ssh', 'agentSession.ensure', {
    envelope: { sessionId: 'someone-elses-chat' }
  })
  const restarted = new DesktopChatCreationHistory(path)
  expect(restarted.sessionIds()).toEqual(['old-chat', 'new-chat'])
  await restarted.removeEnvironment('wsl')
  expect(new DesktopChatCreationHistory(path).sessionIds()).toEqual(['old-chat'])
})

it('treats unreadable history as unknown and never vetoes a create when its write fails', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const path = join(root(), 'not-a-directory')
  writeFileSync(path, 'occupied')
  const history = new DesktopChatCreationHistory(path)
  expect(history.sessionIds()).toEqual([])
  await expect(
    history.recordCreate('ssh', 'agentSession.create', { envelope: { sessionId: 'chat' } })
  ).resolves.toBeUndefined()
  expect(history.sessionIds()).toEqual(['chat'])
  rmSync(path)
  mkdirSync(path)
  await history.recordCreate('ssh', 'agentSession.create', { envelope: { sessionId: 'chat' } })
  expect(new DesktopChatCreationHistory(path).sessionIds()).toEqual(['chat'])
})

it.each([1_000, 10_000])(
  'bounds drained creation work with %i retained memberships',
  async (size) => {
    const path = root()
    const ids = Array.from({ length: size - 1 }, (_, i) => `saved-${i}`)
    writeFileSync(
      join(path, 'desktop-chat-creation-history.json'),
      JSON.stringify({ ssh: ids, alias: ['saved-0'] })
    )
    vi.mocked(readFileSync).mockClear()
    vi.mocked(writeFile).mockClear()
    vi.mocked(rename).mockClear()
    const history = new DesktopChatCreationHistory(path)
    let serializedMemberships = 0
    const stringify = JSON.stringify
    const serialization = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((value, replacer, space) => {
        if (
          value &&
          typeof value === 'object' &&
          'ssh' in value &&
          Array.isArray(value.ssh) &&
          Array.isArray(value.alias)
        ) {
          serializedMemberships += value.ssh.length + value.alias.length
        }
        return stringify(value, replacer, space)
      })
    await history.recordCreate('ssh', 'agentSession.create', { envelope: { sessionId: 'saved-0' } })
    expect(writeFile).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
    for (let i = 0; i < 10; i++) {
      await history.recordCreate('ssh', 'agentSession.create', {
        envelope: { sessionId: `new-${i}` }
      })
    }
    serialization.mockRestore()
    expect(readFileSync).toHaveBeenCalledTimes(1)
    expect(writeFile).toHaveBeenCalledTimes(10)
    expect(rename).toHaveBeenCalledTimes(10)
    // Distinct creates still serialize whole snapshots; unchanged bytes skip only disk replacement.
    expect(serializedMemberships).toBeGreaterThan(0)
    expect(serializedMemberships).toBeLessThanOrEqual(11 * size + 55)
    let visits = 0
    const iterate = Set.prototype[Symbol.iterator]
    const union = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function* (
      this: Set<unknown>
    ) {
      for (const id of iterate.call(this)) {
        visits++
        yield id
      }
      return undefined
    })
    const all = history.sessionIds()
    union.mockRestore()
    expect(visits).toBeLessThanOrEqual(2 * (size + 10))
    expect(all).toEqual([...ids, ...Array.from({ length: 10 }, (_, i) => `new-${i}`)])
  }
)
