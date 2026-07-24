import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const opendirMock = vi.hoisted(() => vi.fn())

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  opendir: opendirMock
}))

import {
  extractGeminiOAuthCredentialsFromBundleDir,
  findGeminiPackageRoot,
  MAX_GEMINI_CLI_BUNDLE_ENTRIES,
  MAX_GEMINI_CLI_BUNDLE_FILES,
  MAX_GEMINI_CLI_OAUTH_SOURCE_BYTES,
  MAX_GEMINI_CLI_PACKAGE_JSON_BYTES,
  readGeminiOAuthCredentialsFile
} from './gemini-cli-oauth-extractor'

const roots: string[] = []

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-gemini-oauth-bounds-'))
  roots.push(root)
  return root
}

function useDirectoryEntries(names: string[]): {
  close: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
} {
  let index = 0
  const directory = {
    close: vi.fn(async () => undefined),
    read: vi.fn(async () => {
      const name = names[index]
      index += 1
      return name === undefined ? null : { name }
    })
  }
  opendirMock.mockResolvedValueOnce(directory)
  return directory
}

function oauthSource(clientId: string, clientSecret: string): string {
  return [
    `const OAUTH_CLIENT_ID = '${clientId}'`,
    `const OAUTH_CLIENT_SECRET = "${clientSecret}"`
  ].join('\n')
}

beforeEach(() => {
  opendirMock.mockReset()
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Gemini CLI OAuth extraction bounds', () => {
  it('preserves credentials from a normal installed source file', async () => {
    const sourcePath = path.join(createRoot(), 'oauth2.js')
    writeFileSync(sourcePath, oauthSource('normal-client', 'normal-secret'))

    await expect(readGeminiOAuthCredentialsFile(sourcePath)).resolves.toEqual({
      clientId: 'normal-client',
      clientSecret: 'normal-secret'
    })
  })

  it('skips an oversized sparse installed source file', async () => {
    const sourcePath = path.join(createRoot(), 'oauth2.js')
    writeFileSync(sourcePath, '')
    truncateSync(sourcePath, MAX_GEMINI_CLI_OAUTH_SOURCE_BYTES + 1)

    await expect(readGeminiOAuthCredentialsFile(sourcePath)).resolves.toBeNull()
  })

  it('accepts package metadata at the exact byte limit', async () => {
    const packageRoot = createRoot()
    const packagePath = path.join(packageRoot, 'package.json')
    const manifest = JSON.stringify({ name: '@google/gemini-cli' })
    writeFileSync(
      packagePath,
      manifest + ' '.repeat(MAX_GEMINI_CLI_PACKAGE_JSON_BYTES - Buffer.byteLength(manifest))
    )

    expect(statSync(packagePath).size).toBe(MAX_GEMINI_CLI_PACKAGE_JSON_BYTES)
    await expect(findGeminiPackageRoot(path.join(packageRoot, 'bin', 'gemini'))).resolves.toBe(
      packageRoot
    )
  })

  it('skips oversized sparse package metadata and keeps walking', async () => {
    const packageRoot = createRoot()
    const nestedRoot = path.join(packageRoot, 'nested')
    mkdirSync(path.join(nestedRoot, 'bin'), { recursive: true })
    writeFileSync(path.join(packageRoot, 'package.json'), manifestForGemini())
    const oversizedManifest = path.join(nestedRoot, 'package.json')
    writeFileSync(oversizedManifest, '')
    truncateSync(oversizedManifest, MAX_GEMINI_CLI_PACKAGE_JSON_BYTES + 1)

    await expect(findGeminiPackageRoot(path.join(nestedRoot, 'bin', 'gemini'))).resolves.toBe(
      packageRoot
    )
  })

  it('streams bundle entries and continues after an oversized sparse chunk', async () => {
    const packageRoot = createRoot()
    const bundleDir = path.join(packageRoot, 'bundle')
    mkdirSync(bundleDir)
    const oversizedPath = path.join(bundleDir, 'old.js')
    writeFileSync(oversizedPath, '')
    truncateSync(oversizedPath, MAX_GEMINI_CLI_OAUTH_SOURCE_BYTES + 1)
    writeFileSync(path.join(bundleDir, 'current.js'), oauthSource('bundle-client', 'bundle-secret'))
    const directory = useDirectoryEntries(['old.js', 'current.js'])

    await expect(extractGeminiOAuthCredentialsFromBundleDir(packageRoot)).resolves.toEqual({
      clientId: 'bundle-client',
      clientSecret: 'bundle-secret'
    })
    expect(directory.read).toHaveBeenCalledTimes(2)
    expect(directory.close).toHaveBeenCalledOnce()
  })

  it('admits a credential chunk at the exact directory entry limit', async () => {
    const packageRoot = createRoot()
    const bundleDir = path.join(packageRoot, 'bundle')
    mkdirSync(bundleDir)
    writeFileSync(path.join(bundleDir, 'credentials.js'), oauthSource('last-client', 'last-secret'))
    const names = [
      ...Array.from({ length: MAX_GEMINI_CLI_BUNDLE_ENTRIES - 1 }, (_, index) => `${index}.txt`),
      'credentials.js'
    ]
    const directory = useDirectoryEntries(names)

    await expect(extractGeminiOAuthCredentialsFromBundleDir(packageRoot)).resolves.toEqual({
      clientId: 'last-client',
      clientSecret: 'last-secret'
    })
    expect(directory.read).toHaveBeenCalledTimes(MAX_GEMINI_CLI_BUNDLE_ENTRIES)
  })

  it('does not retain or inspect a directory entry beyond the cap', async () => {
    const packageRoot = createRoot()
    const bundleDir = path.join(packageRoot, 'bundle')
    mkdirSync(bundleDir)
    writeFileSync(path.join(bundleDir, 'too-late.js'), oauthSource('late-client', 'late-secret'))
    const names = [
      ...Array.from({ length: MAX_GEMINI_CLI_BUNDLE_ENTRIES }, (_, index) => `${index}.txt`),
      'too-late.js'
    ]
    const directory = useDirectoryEntries(names)

    await expect(extractGeminiOAuthCredentialsFromBundleDir(packageRoot)).resolves.toBeNull()
    expect(directory.read).toHaveBeenCalledTimes(MAX_GEMINI_CLI_BUNDLE_ENTRIES)
  })

  it('admits a credential chunk at the exact JavaScript file limit', async () => {
    const packageRoot = createRoot()
    const bundleDir = path.join(packageRoot, 'bundle')
    mkdirSync(bundleDir)
    writeFileSync(path.join(bundleDir, 'credentials.js'), oauthSource('file-client', 'file-secret'))
    const names = [
      ...Array.from(
        { length: MAX_GEMINI_CLI_BUNDLE_FILES - 1 },
        (_, index) => `missing-${index}.js`
      ),
      'credentials.js'
    ]
    const directory = useDirectoryEntries(names)

    await expect(extractGeminiOAuthCredentialsFromBundleDir(packageRoot)).resolves.toEqual({
      clientId: 'file-client',
      clientSecret: 'file-secret'
    })
    expect(directory.read).toHaveBeenCalledTimes(MAX_GEMINI_CLI_BUNDLE_FILES)
  })

  it('does not inspect a JavaScript file beyond the file cap', async () => {
    const packageRoot = createRoot()
    const bundleDir = path.join(packageRoot, 'bundle')
    mkdirSync(bundleDir)
    writeFileSync(path.join(bundleDir, 'too-late.js'), oauthSource('late-client', 'late-secret'))
    const names = [
      ...Array.from({ length: MAX_GEMINI_CLI_BUNDLE_FILES }, (_, index) => `missing-${index}.js`),
      'too-late.js'
    ]
    const directory = useDirectoryEntries(names)

    await expect(extractGeminiOAuthCredentialsFromBundleDir(packageRoot)).resolves.toBeNull()
    expect(directory.read).toHaveBeenCalledTimes(MAX_GEMINI_CLI_BUNDLE_FILES)
  })
})

function manifestForGemini(): string {
  return JSON.stringify({ name: '@google/gemini-cli' })
}
