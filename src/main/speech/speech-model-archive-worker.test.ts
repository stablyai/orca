import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractSpeechModelArchive } from './speech-model-archive-worker'

const HAPPY_ARCHIVE =
  'QlpoOTFBWSZTWd2zR1sAALH/gMmAAIBAAfeAAIBAEG5PnkAISCAAkgypkm/USaDRmpiNPU9PSgikofqmTQ00BtQDQfvmWq4vh0HqBXxYgphJ7aFLh2UIbWVEgGAnKzvBgSISwK441zq86zQgiLyrS3MdpBQGqcTI0++iH+AJ6/nplAiT96utjc5JgG6UYpVLmmBgqlRyIIH8XckU4UJDds0dbA=='
const TRAVERSAL_ARCHIVE =
  'QlpoOTFBWSZTWbpIYDYAAHV9gMmAAAJAAe+AACBmJ57ACAggAHQaJGQNAPKNGjT1BJRDQGnqAAA+6qHoQZSoQiPLUF1dM6BDgcMMabPL4CgYIK4gtSHiqQeYSMprM/H9U9VqR+a90mzENSIgPxdyRThQkLpIYDY='
const SYMLINK_ARCHIVE =
  'QlpoOTFBWSZTWSYy/ysAAHV/gMiAABBAAfcAAACBACYvnkAACCAAVDKnqAPU002oMj1NBJKD1AYgaAH3k6BIL6kIRLuVpcO6BDAxKMSbcM4nYI5QhJNrsvAxLT9oHi8mpk9rr9VUnWOG5JA/F3JFOFCQJjL/Kw=='

function writeArchive(dir: string, base64: string): string {
  const archivePath = join(dir, 'model.tar.bz2')
  writeFileSync(archivePath, Buffer.from(base64, 'base64'))
  return archivePath
}

describe('extractSpeechModelArchive', () => {
  it('extracts regular files after stripping the archive wrapper directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-speech-extractor-'))
    try {
      const destination = join(dir, 'model')
      const archivePath = writeArchive(dir, HAPPY_ARCHIVE)

      await extractSpeechModelArchive(archivePath, destination)

      expect(readFileSync(join(destination, 'tokens.txt'), 'utf8')).toBe('hello')
      expect(readFileSync(join(destination, 'nested', 'encoder.onnx'), 'utf8')).toBe('model')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects traversal paths before they can escape the destination', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-speech-extractor-'))
    try {
      const destination = join(dir, 'model')
      const archivePath = writeArchive(dir, TRAVERSAL_ARCHIVE)

      await expect(extractSpeechModelArchive(archivePath, destination)).rejects.toThrow(
        'Unsafe speech model archive path'
      )
      expect(existsSync(join(dir, 'outside.txt'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects links from model archives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-speech-extractor-'))
    try {
      const destination = join(dir, 'model')
      const archivePath = writeArchive(dir, SYMLINK_ARCHIVE)

      await expect(extractSpeechModelArchive(archivePath, destination)).rejects.toThrow(
        'Unsupported speech model archive entry type'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
