import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GENERATED_NODE_MANAGED_FILE_MAX_BYTES } from '../generated-node-bounded-file-reader'
import {
  getWindowsRelayLivenessProbeSource,
  WINDOWS_RELAY_LIVENESS_DIRECTORY_BUFFER_SIZE,
  WINDOWS_RELAY_LIVENESS_INCONCLUSIVE_STATE,
  WINDOWS_RELAY_LIVENESS_MAX_DIRECTORY_ENTRIES,
  WINDOWS_RELAY_LIVENESS_MAX_PIPE_PATHS
} from './ssh-relay-liveness-probe-source'

const PIPE_A = '\\\\.\\pipe\\orca-relay-00000000000000000000'
const PIPE_B = '\\\\.\\pipe\\orca-relay-11111111111111111111'
const PIPE_C = '\\\\.\\pipe\\orca-relay-22222222222222222222'

function runProbe(
  directory: string,
  options: {
    maxDirectoryEntries: number
    maxPipePaths: number
    seedPipePaths?: string[]
  }
): string {
  const source = getWindowsRelayLivenessProbeSource({
    maxDirectoryEntries: options.maxDirectoryEntries,
    maxPipePaths: options.maxPipePaths,
    directoryBufferSize: 1
  })
  const result = spawnSync(
    process.execPath,
    ['-e', source, directory, ...(options.seedPipePaths ?? [])],
    {
      encoding: 'utf8',
      timeout: 5_000
    }
  )
  if (result.status !== 0) {
    throw new Error(`probe exited ${result.status}: ${result.stderr}`)
  }
  return result.stdout
}

function withTempDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'orca-relay-liveness-'))
  try {
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('Windows relay liveness probe source', () => {
  it('uses fixed-capacity incremental directory iteration', () => {
    const source = getWindowsRelayLivenessProbeSource()

    expect(source).toContain(
      `maxEntries=${WINDOWS_RELAY_LIVENESS_MAX_DIRECTORY_ENTRIES},maxPipes=${WINDOWS_RELAY_LIVENESS_MAX_PIPE_PATHS}`
    )
    expect(source).toContain(
      `opendirSync(dir,{bufferSize:${WINDOWS_RELAY_LIVENESS_DIRECTORY_BUFFER_SIZE}})`
    )
    expect(source).toContain('directory.readSync()')
    expect(source).not.toContain('readdirSync')
    expect(source).not.toContain('pipes.includes')
  })

  it('allows exactly the directory-entry limit', () => {
    withTempDirectory((directory) => {
      writeFileSync(join(directory, 'one'), '')
      writeFileSync(join(directory, 'two'), '')

      expect(
        runProbe(directory, {
          maxDirectoryEntries: 2,
          maxPipePaths: 1,
          seedPipePaths: [PIPE_A]
        })
      ).toBe('WAITING')
    })
  })

  it('fails closed when the incremental iterator finds one entry beyond the limit', () => {
    withTempDirectory((directory) => {
      writeFileSync(join(directory, 'one'), '')
      writeFileSync(join(directory, 'two'), '')
      writeFileSync(join(directory, 'three'), '')

      expect(
        runProbe(directory, {
          maxDirectoryEntries: 2,
          maxPipePaths: 1,
          seedPipePaths: [PIPE_A]
        })
      ).toBe(WINDOWS_RELAY_LIVENESS_INCONCLUSIVE_STATE)
    })
  })

  it('allows exactly the retained-pipe limit', () => {
    withTempDirectory((directory) => {
      writeFileSync(join(directory, '.windows-active-pipe-a'), PIPE_A)
      writeFileSync(join(directory, '.windows-active-pipe-b'), PIPE_B)

      expect(
        runProbe(directory, {
          maxDirectoryEntries: 2,
          maxPipePaths: 2
        })
      ).toBe('WAITING')
    })
  })

  it('fails closed before retaining a pipe beyond the limit', () => {
    withTempDirectory((directory) => {
      writeFileSync(join(directory, '.windows-active-pipe-a'), PIPE_A)
      writeFileSync(join(directory, '.windows-active-pipe-b'), PIPE_B)
      writeFileSync(join(directory, '.windows-active-pipe-c'), PIPE_C)

      expect(
        runProbe(directory, {
          maxDirectoryEntries: 3,
          maxPipePaths: 2
        })
      ).toBe(WINDOWS_RELAY_LIVENESS_INCONCLUSIVE_STATE)
    })
  })

  it('fails closed when a marker exceeds its file-size limit', () => {
    withTempDirectory((directory) => {
      writeFileSync(
        join(directory, '.windows-active-pipe-oversized'),
        'x'.repeat(GENERATED_NODE_MANAGED_FILE_MAX_BYTES + 1)
      )

      expect(
        runProbe(directory, {
          maxDirectoryEntries: 1,
          maxPipePaths: 1
        })
      ).toBe(WINDOWS_RELAY_LIVENESS_INCONCLUSIVE_STATE)
    })
  })

  it('preserves the missing-directory liveness result', () => {
    withTempDirectory((directory) => {
      expect(
        runProbe(join(directory, 'missing'), {
          maxDirectoryEntries: 1,
          maxPipePaths: 1
        })
      ).toBe('ALIVE')
    })
  })
})
