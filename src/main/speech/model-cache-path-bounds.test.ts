import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrateSpeechModelCacheIfNeeded } from './model-cache-path'

describe('speech model cache migration bounds', () => {
  const cleanupPaths: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(
      cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  async function createMigrationDirs(): Promise<{ sourceDir: string; targetDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'orca-speech-migration-'))
    cleanupPaths.push(root)
    const sourceDir = join(root, 'source')
    const targetDir = join(root, 'target')
    await Promise.all([
      mkdir(sourceDir, { recursive: true }),
      mkdir(targetDir, { recursive: true })
    ])
    return { sourceDir, targetDir }
  }

  it('copies every entry at the exact count limit', async () => {
    const { sourceDir, targetDir } = await createMigrationDirs()
    await Promise.all([
      writeFile(join(sourceDir, 'encoder.onnx'), 'encoder'),
      writeFile(join(sourceDir, 'tokens.txt'), 'tokens')
    ])

    await migrateSpeechModelCacheIfNeeded(sourceDir, targetDir, { maxEntries: 2 })

    expect((await readdir(targetDir)).sort()).toEqual(['encoder.onnx', 'tokens.txt'])
  })

  it('stops before copying the first entry over the count limit', async () => {
    const { sourceDir, targetDir } = await createMigrationDirs()
    await Promise.all([
      writeFile(join(sourceDir, 'encoder.onnx'), 'encoder'),
      writeFile(join(sourceDir, 'decoder.onnx'), 'decoder'),
      writeFile(join(sourceDir, 'tokens.txt'), 'tokens')
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await migrateSpeechModelCacheIfNeeded(sourceDir, targetDir, { maxEntries: 2 })

    expect(await readdir(targetDir)).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(
      '[speech] Failed to migrate speech model cache to ASCII path:',
      expect.objectContaining({ message: expect.stringContaining('exceeded 2 entries') })
    )
  })

  it('stops traversal beyond the configured depth', async () => {
    const { sourceDir, targetDir } = await createMigrationDirs()
    await mkdir(join(sourceDir, 'model', 'nested'), { recursive: true })
    await writeFile(join(sourceDir, 'model', 'nested', 'encoder.onnx'), 'encoder')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await migrateSpeechModelCacheIfNeeded(sourceDir, targetDir, { maxDepth: 2 })

    await expect(readFile(join(targetDir, 'model', 'nested', 'encoder.onnx'))).rejects.toThrow()
    expect(warn).toHaveBeenCalledWith(
      '[speech] Failed to migrate speech model cache to ASCII path:',
      expect.objectContaining({ message: expect.stringContaining('exceeded depth 2') })
    )
  })

  it('accepts the exact visited-path byte budget and rejects one byte less', async () => {
    const exact = await createMigrationDirs()
    await writeFile(join(exact.sourceDir, 'tokens.txt'), 'tokens')
    const exactBytes =
      Buffer.byteLength(join(exact.sourceDir, 'tokens.txt'), 'utf8') +
      Buffer.byteLength(join(exact.targetDir, 'tokens.txt'), 'utf8')

    await migrateSpeechModelCacheIfNeeded(exact.sourceDir, exact.targetDir, {
      maxVisitedPathBytes: exactBytes
    })
    await expect(readFile(join(exact.targetDir, 'tokens.txt'), 'utf8')).resolves.toBe('tokens')

    const overflow = await createMigrationDirs()
    await writeFile(join(overflow.sourceDir, 'tokens.txt'), 'tokens')
    const overflowBytes =
      Buffer.byteLength(join(overflow.sourceDir, 'tokens.txt'), 'utf8') +
      Buffer.byteLength(join(overflow.targetDir, 'tokens.txt'), 'utf8')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await migrateSpeechModelCacheIfNeeded(overflow.sourceDir, overflow.targetDir, {
      maxVisitedPathBytes: overflowBytes - 1
    })
    await expect(readFile(join(overflow.targetDir, 'tokens.txt'))).rejects.toThrow()
  })

  it('keeps an existing target file unchanged', async () => {
    const { sourceDir, targetDir } = await createMigrationDirs()
    await writeFile(join(sourceDir, 'tokens.txt'), 'source')
    await writeFile(join(targetDir, 'tokens.txt'), 'existing')

    await migrateSpeechModelCacheIfNeeded(sourceDir, targetDir)

    await expect(readFile(join(targetDir, 'tokens.txt'), 'utf8')).resolves.toBe('existing')
  })
})
