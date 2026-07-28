import { beforeEach, describe, expect, it, vi } from 'vitest'

const { opendirMock, accessMock, realpathMock, readWithinLimitMock } = vi.hoisted(() => ({
  opendirMock: vi.fn(),
  accessMock: vi.fn(),
  realpathMock: vi.fn(),
  readWithinLimitMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  opendir: opendirMock,
  access: accessMock,
  realpath: realpathMock
}))

vi.mock('../../shared/memory-safety/node-bounded-file-reader', () => ({
  readNodeFileWithinLimit: readWithinLimitMock
}))

import {
  extractGeminiOAuthCredentialsFromBundleDir,
  findGeminiPackageRoot,
  MAX_GEMINI_CLI_BUNDLE_BYTES,
  MAX_GEMINI_CLI_BUNDLE_ENTRIES,
  MAX_GEMINI_CLI_BUNDLE_FILES,
  MAX_GEMINI_CLI_OAUTH_SOURCE_BYTES,
  MAX_GEMINI_CLI_PACKAGE_JSON_BYTES,
  readGeminiOAuthCredentialsFile
} from './gemini-cli-oauth-extractor'

const CREDENTIAL_SOURCE = `const OAUTH_CLIENT_ID = 'client-id-x';const OAUTH_CLIENT_SECRET = 'secret-y';`

/** Reports a byte length without allocating it, so ceiling arithmetic is exercised cheaply. */
function sourceOfSize(byteLength: number, text: string): { buffer: Buffer } {
  return { buffer: { length: byteLength, toString: () => text } as unknown as Buffer }
}

function directoryOf(names: string[]): void {
  let index = 0
  opendirMock.mockResolvedValue({
    read: async () => (index < names.length ? { name: names[index++] } : null),
    close: async () => undefined
  })
}

describe('gemini CLI OAuth extractor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    accessMock.mockRejectedValue(new Error('missing'))
    readWithinLimitMock.mockResolvedValue(sourceOfSize(64, 'no credentials here'))
  })

  it('reads an OAuth source under a 32 MiB ceiling', async () => {
    // Literal ceiling: asserting the constant itself would pass at any value.
    expect(MAX_GEMINI_CLI_OAUTH_SOURCE_BYTES).toBe(32 * 1024 * 1024)
    readWithinLimitMock.mockResolvedValue(sourceOfSize(128, CREDENTIAL_SOURCE))

    await expect(readGeminiOAuthCredentialsFile('/pkg/oauth2.js')).resolves.toEqual({
      clientId: 'client-id-x',
      clientSecret: 'secret-y'
    })
    expect(readWithinLimitMock).toHaveBeenCalledWith('/pkg/oauth2.js', 32 * 1024 * 1024)
  })

  it('reads a package.json under a 1 MiB ceiling while resolving the package root', async () => {
    expect(MAX_GEMINI_CLI_PACKAGE_JSON_BYTES).toBe(1024 * 1024)
    readWithinLimitMock.mockResolvedValue(
      sourceOfSize(64, JSON.stringify({ name: '@google/gemini-cli' }))
    )

    await expect(findGeminiPackageRoot('/usr/local/lib/gemini-cli/bin/gemini')).resolves.toBe(
      '/usr/local/lib/gemini-cli/bin'
    )
    expect(readWithinLimitMock).toHaveBeenCalledWith(
      '/usr/local/lib/gemini-cli/bin/package.json',
      1024 * 1024
    )
  })

  it('stops scanning the bundle directory after 4,096 entries', async () => {
    expect(MAX_GEMINI_CLI_BUNDLE_ENTRIES).toBe(4_096)
    // The only credential-bearing file sits just past the entry ceiling.
    directoryOf([
      ...Array.from({ length: 4_096 }, (_unused, index) => `asset-${index}.txt`),
      'a.js'
    ])
    readWithinLimitMock.mockResolvedValue(sourceOfSize(128, CREDENTIAL_SOURCE))

    await expect(extractGeminiOAuthCredentialsFromBundleDir('/pkg')).resolves.toBeNull()
    expect(readWithinLimitMock).not.toHaveBeenCalled()
  })

  it('stops scanning the bundle directory after 512 JavaScript files', async () => {
    expect(MAX_GEMINI_CLI_BUNDLE_FILES).toBe(512)
    directoryOf(Array.from({ length: 513 }, (_unused, index) => `chunk-${index}.js`))
    readWithinLimitMock.mockImplementation(async (filePath: string) =>
      filePath.endsWith('chunk-512.js')
        ? sourceOfSize(128, CREDENTIAL_SOURCE)
        : sourceOfSize(128, 'no credentials here')
    )

    await expect(extractGeminiOAuthCredentialsFromBundleDir('/pkg')).resolves.toBeNull()
    expect(readWithinLimitMock).toHaveBeenCalledTimes(512)
  })

  it('stops scanning the bundle directory after 128 MiB of inspected sources', async () => {
    expect(MAX_GEMINI_CLI_BUNDLE_BYTES).toBe(128 * 1024 * 1024)
    directoryOf(['big-a.js', 'big-b.js', 'creds.js'])
    // 96 MiB is admitted; the next file exceeds the 32 MiB that remains, so the scan stops
    // before reaching the credential-bearing file behind it.
    readWithinLimitMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('big-a.js')) {
        return sourceOfSize(96 * 1024 * 1024, 'padding')
      }
      if (filePath.endsWith('big-b.js')) {
        return sourceOfSize(33 * 1024 * 1024, 'padding')
      }
      return sourceOfSize(128, CREDENTIAL_SOURCE)
    })

    await expect(extractGeminiOAuthCredentialsFromBundleDir('/pkg')).resolves.toBeNull()
    expect(readWithinLimitMock).toHaveBeenCalledTimes(2)
  })

  it('closes the bundle directory even when a read throws', async () => {
    const close = vi.fn(async () => undefined)
    opendirMock.mockResolvedValue({
      read: async () => {
        throw new Error('directory vanished')
      },
      close
    })

    await expect(extractGeminiOAuthCredentialsFromBundleDir('/pkg')).resolves.toBeNull()
    expect(close).toHaveBeenCalledOnce()
  })
})
