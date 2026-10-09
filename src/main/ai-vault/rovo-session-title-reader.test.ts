import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRovoSessionTitle } from './rovo-session-title-reader'

let home: string
let roots: string[]

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'orca-rovo-title-'))
  roots = [join(home, '.rovo', 'sessions'), join(home, '.rovodev', 'sessions')]
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function writeMetadata(root: string, sessionId: string, metadata: unknown): Promise<void> {
  await mkdir(join(root, sessionId), { recursive: true })
  await writeFile(join(root, sessionId, 'metadata.json'), JSON.stringify(metadata))
}

describe('readRovoSessionTitle', () => {
  it('reads the title Rovo generated for the session', async () => {
    await writeMetadata(roots[0]!, 'abc-123', { title: ' Day of the Week Check ' })

    await expect(readRovoSessionTitle('abc-123', { roots })).resolves.toBe('Day of the Week Check')
  })

  it('prefers ~/.rovo over the legacy ~/.rovodev copy', async () => {
    await writeMetadata(roots[0]!, 'abc-123', { title: 'Renamed', is_manual_title: true })
    await writeMetadata(roots[1]!, 'abc-123', { title: 'Old copy' })

    await expect(readRovoSessionTitle('abc-123', { roots })).resolves.toBe('Renamed')
  })

  it('falls back to legacy sessions and to the next root when a title is missing', async () => {
    await writeMetadata(roots[0]!, 'abc-123', { title: null })
    await writeMetadata(roots[1]!, 'abc-123', { title: 'Legacy title' })

    await expect(readRovoSessionTitle('abc-123', { roots })).resolves.toBe('Legacy title')
  })

  it('returns null for untitled, malformed, or missing sessions', async () => {
    await writeMetadata(roots[0]!, 'untitled', { is_manual_title: false })
    await mkdir(join(roots[0]!, 'broken'), { recursive: true })
    await writeFile(join(roots[0]!, 'broken', 'metadata.json'), '{"title": "half')

    await expect(readRovoSessionTitle('untitled', { roots })).resolves.toBeNull()
    await expect(readRovoSessionTitle('broken', { roots })).resolves.toBeNull()
    await expect(readRovoSessionTitle('missing', { roots })).resolves.toBeNull()
  })

  it('never resolves path-like session ids outside the sessions roots', async () => {
    await writeMetadata(home, 'escaped', { title: 'Outside' })

    await expect(readRovoSessionTitle('../../escaped', { roots })).resolves.toBeNull()
    await expect(readRovoSessionTitle('a/../../escaped', { roots })).resolves.toBeNull()
    await expect(readRovoSessionTitle('..', { roots })).resolves.toBeNull()
  })
})
