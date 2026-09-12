import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, readdirSync } from 'node:fs'
import { chmod, copyFile, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import extractZip from 'extract-zip'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import {
  ORCAD_BUN_RELEASE_ASSETS,
  ORCAD_BUN_VERSION,
  orcadBunReleaseUrl,
  type OrcadBunTarget
} from '../../shared/orcad-bun-runtime'

const MAX_BUN_ARCHIVE_BYTES = 200 * 1024 * 1024

export type OrcadBunRuntimeMaterializeOptions = {
  fetcher?: typeof fetch
  signal?: AbortSignal
}

export async function materializeCachedOrcadBunRuntime(
  target: OrcadBunTarget,
  cacheRoot: string,
  options: OrcadBunRuntimeMaterializeOptions
): Promise<string> {
  const asset = ORCAD_BUN_RELEASE_ASSETS[target]
  const runtimeDir = join(cacheRoot, 'bun', `v${ORCAD_BUN_VERSION}`, target)
  const runtimePath = join(runtimeDir, orcadBunRuntimeFilename(target))
  await mkdir(runtimeDir, { recursive: true })
  if ((await fileSha256(runtimePath)) === asset.executableSha256) {
    return runtimePath
  }
  await rm(runtimePath, { force: true })
  const temporaryDir = join(runtimeDir, `.download-${process.pid}-${randomUUID()}`)
  await mkdir(temporaryDir, { recursive: true })
  try {
    const archivePath = join(temporaryDir, basename(asset.filename))
    await downloadVerifiedArchive(
      orcadBunReleaseUrl(asset),
      archivePath,
      asset.sha256,
      options.fetcher ?? fetch,
      options.signal
    )
    const extractedDir = join(temporaryDir, 'extracted')
    await mkdir(extractedDir)
    await extractZip(archivePath, { dir: extractedDir })
    const executable = findExtractedBun(extractedDir, target)
    await verifyFileSha256(executable, asset.executableSha256, `${target} Bun executable`)
    const partialPath = `${runtimePath}.partial-${process.pid}-${randomUUID()}`
    await copyFile(executable, partialPath)
    if (!target.startsWith('win32-')) {
      await chmod(partialPath, 0o755)
    }
    try {
      await rename(partialPath, runtimePath)
    } catch (error) {
      if ((await fileSha256(runtimePath)) !== asset.executableSha256) {
        throw error
      }
      await rm(partialPath, { force: true })
    }
    await verifyFileSha256(runtimePath, asset.executableSha256, `${target} cached Bun executable`)
    return runtimePath
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

async function downloadVerifiedArchive(
  url: string,
  destination: string,
  expectedSha256: string,
  fetcher: typeof fetch,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetcher(url, { redirect: 'follow', signal })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Bun download failed: ${response.status} ${response.statusText}`)
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BUN_ARCHIVE_BYTES) {
    await response.body.cancel().catch(() => undefined)
    throw new Error('Bun download exceeded the archive size limit')
  }
  const reader = response.body.getReader()
  const handle = await open(destination, 'wx', 0o600)
  const hash = createHash('sha256')
  let total = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      total += chunk.value.byteLength
      if (total > MAX_BUN_ARCHIVE_BYTES) {
        throw new Error('Bun download exceeded the archive size limit')
      }
      hash.update(chunk.value)
      await writeAll(handle, chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    await handle.close()
  }
  const actual = hash.digest('hex')
  if (actual !== expectedSha256) {
    throw new Error(`Bun archive checksum mismatch: expected ${expectedSha256}, got ${actual}`)
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (bytesWritten === 0) {
      throw new Error('Bun archive write made no progress')
    }
    offset += bytesWritten
  }
}

function findExtractedBun(root: string, target: OrcadBunTarget): string {
  const expected = target.startsWith('win32-') ? 'bun.exe' : 'bun'
  const entry = readdirSync(root, { recursive: true, withFileTypes: true }).find(
    (candidate) => candidate.isFile() && candidate.name === expected
  )
  if (!entry) {
    throw new Error(`Downloaded Bun archive contained no ${expected}`)
  }
  return join(entry.parentPath, entry.name)
}

export async function verifyFileSha256(
  path: string,
  expected: string,
  label: string
): Promise<void> {
  const actual = await fileSha256(path)
  if (actual !== expected) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual ?? 'missing'}`)
  }
}

async function fileSha256(path: string): Promise<string | null> {
  try {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk)
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}
