import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_PIN,
  nodeRuntimeExecutablePath
} from '../../shared/node-runtime-pin'
import { materializeNodeRuntimeArchive } from './pinned-runtime-materializer'

const TARGET = 'linux-x64-glibc' as const
const originalAsset = { ...NODE_RUNTIME_ASSETS[TARGET] }
let root = ''

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fetcherFor(body: Uint8Array): typeof fetch {
  return vi.fn<typeof fetch>(async () => new Response(Buffer.from(body), { status: 200 }))
}

/** A real .tar.gz laid out like the official one, so extraction runs the host's tar. */
async function nodeDistArchiveFixture(executable: Uint8Array): Promise<Uint8Array> {
  const staging = join(root, 'staging')
  const member = nodeRuntimeExecutablePath(TARGET, NODE_RUNTIME_ASSETS[TARGET].archive)
  await mkdir(join(staging, member, '..'), { recursive: true })
  await writeFile(join(staging, member), executable)
  await writeFile(join(staging, member.split('/')[0]!, 'README.md'), 'not extracted')
  const archivePath = join(root, 'archive.tar.gz')
  const result = await runProcess({
    program: 'tar',
    args: ['-czf', archivePath, '-C', staging, member.split('/')[0]!]
  })
  expect(result.code, result.stderr).toBe(0)
  return new Uint8Array(await readFile(archivePath))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-node-runtime-materializer-'))
})

afterEach(async () => {
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], originalAsset)
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('pinned Node runtime materializer', () => {
  it('keeps the verified archive for upload and refetches only when it is corrupted', async () => {
    const archive = await nodeDistArchiveFixture(new TextEncoder().encode('node'))
    Object.assign(NODE_RUNTIME_ASSETS[TARGET], { archiveSha256: sha256(archive) })
    const cacheRoot = join(root, 'cache')
    const fetcher = fetcherFor(archive)

    const cached = await materializeNodeRuntimeArchive(TARGET, cacheRoot, { fetcher })
    expect(cached.endsWith(originalAsset.archive)).toBe(true)
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(`/v${NODE_RUNTIME_PIN.version}/${originalAsset.archive}`),
      expect.objectContaining({ redirect: 'follow' })
    )
    expect(await materializeNodeRuntimeArchive(TARGET, cacheRoot, { fetcher })).toBe(cached)
    expect(fetcher).toHaveBeenCalledOnce()

    await writeFile(cached, 'torn')
    const repaired = await materializeNodeRuntimeArchive(TARGET, cacheRoot, { fetcher })
    expect(repaired).not.toBe(cached)
    expect(sha256(new Uint8Array(await readFile(repaired)))).toBe(sha256(archive))
  })

  it('refuses an archive that does not match the pin before caching it', async () => {
    const archive = await nodeDistArchiveFixture(new TextEncoder().encode('node'))
    await expect(
      materializeNodeRuntimeArchive(TARGET, join(root, 'cache'), { fetcher: fetcherFor(archive) })
    ).rejects.toThrow('Node archive checksum mismatch')
  })
})
