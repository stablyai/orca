import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
import type * as RipgrepAvailability from '../shared/ripgrep-process-availability'

const { spawnMock, cwdUsableMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  cwdUsableMock: vi.fn()
}))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawnMock }))
vi.mock('./relay-bundled-ripgrep', () => ({ resolveRelayRipgrepCommand: () => '/tools/rg' }))
vi.mock('../shared/ripgrep-process-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof RipgrepAvailability>()),
  isRipgrepSpawnCwdUsable: cwdUsableMock
}))

import { RipgrepUnavailableError } from '../shared/ripgrep-process-availability'
import { listRelayMarkdownDocuments } from './fs-markdown-document-listing'

class ListingProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid: number | undefined = undefined
  exitCode: number | null = null
  signalCode = null
  kill = vi.fn(() => true)
}

let child: ListingProcess
beforeEach(() => {
  child = new ListingProcess()
  spawnMock.mockReset().mockReturnValue(child)
  cwdUsableMock.mockReset().mockResolvedValue(true)
})

it('tags only a missing launch in a usable root for the existing listing fallback', async () => {
  const result = listRelayMarkdownDocuments('/repo')
  child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
  await expect(result).rejects.toThrow(RipgrepUnavailableError)
})

it('keeps an unreachable root out of the missing-binary fallback', async () => {
  cwdUsableMock.mockResolvedValue(false)
  const result = listRelayMarkdownDocuments('/repo')
  child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
  await expect(result).rejects.toThrow('Search root is not reachable')
})

it('keeps unusable native launchers on the existing listing fallback', async () => {
  child.pid = 123
  child.exitCode = 127
  const result = listRelayMarkdownDocuments('/repo')
  child.emit('close', 127, null)
  await expect(result).rejects.toThrow(RipgrepUnavailableError)
})

it.each(['EMFILE', 'EAGAIN'])(
  'preserves %s pressure without retrying another scan',
  async (code) => {
    const error = Object.assign(new Error(`spawn ${code}`), { code })
    const result = listRelayMarkdownDocuments('/repo')
    child.emit('error', error)
    await expect(result).rejects.toBe(error)
    expect(cwdUsableMock).not.toHaveBeenCalled()
  }
)

it('preserves readable SSH documents after an unreadable subtree', async () => {
  child.pid = 123
  const result = listRelayMarkdownDocuments('/repo')
  child.stdout.write('./README.md\0')
  child.stderr.write('Permission denied')
  child.emit('close', 2, null)
  await expect(result).resolves.toEqual([
    {
      filePath: '/repo/README.md',
      relativePath: 'README.md',
      basename: 'README.md',
      name: 'README'
    }
  ])
  expect(cwdUsableMock).not.toHaveBeenCalled()
})

it('still rejects a permission failure that produced no readable documents', async () => {
  child.pid = 123
  const result = listRelayMarkdownDocuments('/repo')
  child.stderr.write('Permission denied')
  child.emit('close', 2, null)
  await expect(result).rejects.toThrow('Permission denied')
  expect(cwdUsableMock).not.toHaveBeenCalled()
})

it('does not accept an incomplete record with the historical partial listing policy', async () => {
  child.pid = 123
  const result = listRelayMarkdownDocuments('/repo')
  child.stdout.write('./README.md\0./truncated')
  child.emit('close', 2, null)
  await expect(result).rejects.toThrow('Incomplete path')
  expect(cwdUsableMock).not.toHaveBeenCalled()
})
