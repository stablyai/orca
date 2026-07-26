import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GENERATED_NODE_MANAGED_FILE_MAX_BYTES,
  getGeneratedNodeBoundedFileReaderSourceLines
} from './generated-node-bounded-file-reader'

type GeneratedReader = (
  fs: {
    closeSync: typeof closeSync
    openSync: typeof openSync
    readSync: typeof readSync
  },
  path: string
) => string

const temporaryDirectories: string[] = []

function buildGeneratedReader(): GeneratedReader {
  const module = { exports: undefined as GeneratedReader | undefined }
  runInNewContext(
    [
      ...getGeneratedNodeBoundedFileReaderSourceLines(),
      'module.exports = readOrcaManagedFileWithinLimit;'
    ].join('\n'),
    { Buffer, module }
  )
  if (!module.exports) {
    throw new Error('generated bounded reader did not export')
  }
  return module.exports
}

function createFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-generated-node-read-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'managed-file')
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('generated Node bounded file reader', () => {
  it('preserves ordinary managed-file contents', () => {
    const path = createFile('stable 🐋 endpoint')

    expect(buildGeneratedReader()({ openSync, readSync, closeSync }, path)).toBe(
      'stable 🐋 endpoint'
    )
  })

  it('accepts a file at the exact byte cap', () => {
    const path = createFile('x'.repeat(GENERATED_NODE_MANAGED_FILE_MAX_BYTES))

    expect(
      Buffer.byteLength(buildGeneratedReader()({ openSync, readSync, closeSync }, path), 'utf8')
    ).toBe(GENERATED_NODE_MANAGED_FILE_MAX_BYTES)
  })

  it('rejects a sparse oversized file and always closes its descriptor', () => {
    const path = createFile('')
    truncateSync(path, GENERATED_NODE_MANAGED_FILE_MAX_BYTES + 1)
    const close = vi.fn(closeSync)

    expect(() => buildGeneratedReader()({ openSync, readSync, closeSync: close }, path)).toThrow(
      `Managed Orca file exceeds ${GENERATED_NODE_MANAGED_FILE_MAX_BYTES} bytes`
    )
    expect(close).toHaveBeenCalledOnce()
  })
})
