import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { hasLivePeer, hasRegisteredGrokHookOwner } from './grok-hook-owners'

describe('Grok hook owners', () => {
  const directories: string[] = []

  async function makeDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'orca-grok-owners-'))
    directories.push(directory)
    return directory
  }

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
  })

  it('keeps the shared hook while another Orca process is live', async () => {
    const directory = await makeDirectory()
    const peer = { token: '11111111-1111-4111-8111-111111111111', pid: 42 }
    await writeFile(join(directory, `owner-${peer.token}.json`), JSON.stringify(peer))

    await expect(hasLivePeer(directory, 'self', vi.fn().mockResolvedValue(true))).resolves.toBe(
      true
    )
  })

  it('prunes dead and malformed owners before allowing cleanup', async () => {
    const directory = await makeDirectory()
    const dead = { token: '22222222-2222-4222-8222-222222222222', pid: 43 }
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `owner-${dead.token}.json`), JSON.stringify(dead))
    await writeFile(join(directory, 'owner-33333333-3333-4333-8333-333333333333.json'), 'not json')

    await expect(hasLivePeer(directory, 'self', vi.fn().mockResolvedValue(false))).resolves.toBe(
      false
    )
    await expect(
      readFile(join(directory, `owner-${dead.token}.json`), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the hook when peer liveness is unverifiable', async () => {
    const directory = await makeDirectory()
    const peer = { token: '44444444-4444-4444-8444-444444444444', pid: 44 }
    await writeFile(join(directory, `owner-${peer.token}.json`), JSON.stringify(peer))

    await expect(
      hasLivePeer(directory, 'self', vi.fn().mockResolvedValue(undefined))
    ).resolves.toBe(true)
  })

  it('detects a new owner record without another liveness probe', async () => {
    const directory = await makeDirectory()
    const peer = { token: '55555555-5555-4555-8555-555555555555', pid: 45 }
    await writeFile(join(directory, `owner-${peer.token}.json`), JSON.stringify(peer))

    await expect(hasRegisteredGrokHookOwner(directory)).resolves.toBe(true)
  })
})
