import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireSpeechHotwordsFile } from './hotwords-file'

const tempDirectories: string[] = []

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-speech-hotwords-'))
  tempDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('acquireSpeechHotwordsFile', () => {
  it('writes normalized sherpa hotwords with stable scoring', async () => {
    const directory = await makeTempDirectory()
    const lease = await acquireSpeechHotwordsFile(
      [' Orca ', 'orca', 'Qwen3-ASR', '中文术语', 'line\nbreak'],
      directory
    )

    expect(lease?.filePath).toMatch(/speech-hotwords-[a-f0-9]{12}\.txt$/)
    expect(await readFile(lease!.filePath, 'utf-8')).toBe(
      'Orca :2.0\nQwen3-ASR :2.0\n中文术语 :2.0\n'
    )
    await lease?.release()
  })

  it('does not create a file when no valid hotwords remain', async () => {
    const directory = await makeTempDirectory()

    await expect(acquireSpeechHotwordsFile(['', 'line\nbreak'], directory)).resolves.toBeUndefined()
  })

  it('keeps a shared digest file until every lease is released', async () => {
    const directory = await makeTempDirectory()
    const first = await acquireSpeechHotwordsFile(['Orca'], directory)
    const second = await acquireSpeechHotwordsFile(['Orca'], directory)

    expect(first?.filePath).toBe(second?.filePath)
    await first?.release()
    await expect(access(second!.filePath)).resolves.toBeUndefined()

    await first?.release()
    await expect(access(second!.filePath)).resolves.toBeUndefined()

    await second?.release()
    await expect(access(second!.filePath)).rejects.toThrow()
  })
})
