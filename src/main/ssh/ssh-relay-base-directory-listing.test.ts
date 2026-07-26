import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getRelayBaseDirectoryListingCommand,
  RELAY_BASE_DIRECTORY_LISTING_LIMIT_SENTINEL,
  RELAY_BASE_DIRECTORY_MAX_ENTRIES,
  RELAY_BASE_DIRECTORY_MAX_UTF8_BYTES
} from './ssh-relay-base-directory-listing'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')

function decodePowerShellCommand(command: string): string {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : ''
}

function runPosixListing(
  directory: string,
  options: { maxEntries: number; maxUtf8Bytes: number }
): string[] {
  const result = spawnSync(
    '/bin/sh',
    ['-c', getRelayBaseDirectoryListingCommand(posix, directory, options)],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(`listing exited ${result.status}: ${result.stderr}`)
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function withTempDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'orca-relay-listing-'))
  try {
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('relay base-directory listing', () => {
  it('streams POSIX entries through fixed entry and byte budgets', () => {
    const command = getRelayBaseDirectoryListingCommand(posix, '/home/u/.orca-remote')

    expect(command).toContain('find "$base" -mindepth 1 -maxdepth 1 -print')
    expect(command).toContain(`entry_count>${RELAY_BASE_DIRECTORY_MAX_ENTRIES}`)
    expect(command).toContain(`output_bytes+line_bytes>${RELAY_BASE_DIRECTORY_MAX_UTF8_BYTES}`)
    expect(command).toContain('| sort')
    expect(command).not.toContain('ls -1')
  })

  it('allows the exact POSIX entry and output-byte bounds', () => {
    withTempDirectory((directory) => {
      mkdirSync(join(directory, 'a'))
      mkdirSync(join(directory, 'b'))

      expect(
        runPosixListing(directory, {
          maxEntries: 2,
          maxUtf8Bytes: 4
        }).sort()
      ).toEqual(['a', 'b'])
    })
  })

  it('emits a sentinel on the first POSIX entry beyond the bound', () => {
    withTempDirectory((directory) => {
      mkdirSync(join(directory, 'a'))
      mkdirSync(join(directory, 'b'))
      mkdirSync(join(directory, 'c'))

      expect(
        runPosixListing(directory, {
          maxEntries: 2,
          maxUtf8Bytes: 100
        })
      ).toContain(RELAY_BASE_DIRECTORY_LISTING_LIMIT_SENTINEL)
    })
  })

  it('emits a sentinel before exceeding the POSIX output-byte bound', () => {
    withTempDirectory((directory) => {
      mkdirSync(join(directory, 'aa'))
      mkdirSync(join(directory, 'bb'))

      const lines = runPosixListing(directory, {
        maxEntries: 2,
        maxUtf8Bytes: 5
      })

      expect(lines).toContain(RELAY_BASE_DIRECTORY_LISTING_LIMIT_SENTINEL)
      expect(
        lines.filter((line) => line !== RELAY_BASE_DIRECTORY_LISTING_LIMIT_SENTINEL)
      ).toHaveLength(1)
    })
  })

  it('uses a disposable streaming iterator on Windows', () => {
    const script = decodePowerShellCommand(
      getRelayBaseDirectoryListingCommand(windows, 'C:/Users/u/.orca-remote')
    )

    expect(script).toContain('[System.IO.Directory]::EnumerateDirectories($base)')
    expect(script).toContain('.GetEnumerator()')
    expect(script).toContain('$iterator.MoveNext()')
    expect(script).toContain('$iterator.Dispose()')
    expect(script).toContain(`$maxEntries = ${RELAY_BASE_DIRECTORY_MAX_ENTRIES}`)
    expect(script).toContain(`$maxBytes = ${RELAY_BASE_DIRECTORY_MAX_UTF8_BYTES}`)
    expect(script).toContain('UTF8.GetByteCount($name) + 2')
    expect(script).toContain(RELAY_BASE_DIRECTORY_LISTING_LIMIT_SENTINEL)
    expect(script).not.toContain('Get-ChildItem')
  })
})
