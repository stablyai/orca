import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  validateSshRelayNodeReleaseContract,
  verifySshRelayNodeArchive,
  verifySshRelayNodeChecksumDocument,
  verifySshRelayNodeSignature
} from './ssh-relay-node-release-verification.mjs'
import { parseArguments, verifyNodeReleaseInputs } from './verify-ssh-relay-node-release-inputs.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const archives = {
  'linux-x64-glibc': {
    name: 'node-v24.18.0-linux-x64.tar.xz',
    sha256: '1'.repeat(64)
  },
  'linux-arm64-glibc': {
    name: 'node-v24.18.0-linux-arm64.tar.xz',
    sha256: '2'.repeat(64)
  },
  'darwin-x64': {
    name: 'node-v24.18.0-darwin-x64.tar.xz',
    sha256: '3'.repeat(64)
  },
  'darwin-arm64': {
    name: 'node-v24.18.0-darwin-arm64.tar.xz',
    sha256: '4'.repeat(64)
  },
  'win32-x64': {
    name: 'node-v24.18.0-win-x64.zip',
    sha256: '5'.repeat(64)
  },
  'win32-arm64': {
    name: 'node-v24.18.0-win-arm64.zip',
    sha256: '6'.repeat(64)
  }
}
const windowsBuildInputs = {
  headersArchive: {
    name: 'node-v24.18.0-headers.tar.gz',
    sha256: '7'.repeat(64)
  },
  importLibraries: {
    'win32-arm64': { name: 'win-arm64/node.lib', sha256: '8'.repeat(64) },
    'win32-x64': { name: 'win-x64/node.lib', sha256: '9'.repeat(64) }
  }
}

function pinnedFiles() {
  return [
    ...Object.values(archives),
    windowsBuildInputs.headersArchive,
    ...Object.values(windowsBuildInputs.importLibraries)
  ]
}

function contract(overrides = {}) {
  return {
    schemaVersion: 1,
    nodeVersion: '24.18.0',
    baseUrl: 'https://nodejs.org/dist/v24.18.0',
    checksumDocument: {
      name: 'SHASUMS256.txt',
      sha256: 'a'.repeat(64),
      maximumBytes: 1024 * 1024
    },
    signature: {
      name: 'SHASUMS256.txt.sig',
      sha256: 'b'.repeat(64),
      maximumBytes: 64 * 1024,
      signerFingerprint: 'C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C',
      key: {
        path: 'ssh-relay-node-release-keys/C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C.asc',
        sha256: 'c'.repeat(64),
        sourceCommit: 'd'.repeat(40),
        sourceUrl:
          `https://raw.githubusercontent.com/nodejs/release-keys/${'d'.repeat(40)}` +
          '/keys/C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C.asc'
      }
    },
    maximumArchiveBytes: 100 * 1024 * 1024,
    archives,
    windowsBuildInputs,
    ...overrides
  }
}

const temporaryDirectories = []
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('SSH relay Node release verification', () => {
  it('pins the reviewed official Node release contract and release key bytes', async () => {
    const contractUrl = new URL('../ssh-relay-node-release-v24.18.0.json', import.meta.url)
    const release = JSON.parse(await readFile(contractUrl, 'utf8'))
    const keyUrl = new URL(`../${release.signature.key.path}`, import.meta.url)

    expect(validateSshRelayNodeReleaseContract(release)).toBe(release)
    expect(digest(await readFile(keyUrl))).toBe(release.signature.key.sha256)
    expect(release.checksumDocument.sha256).toBe(
      '3927bab574a00ca0560c9583fe19655ba19603a1c5851414e4325d34ac50e469'
    )
    expect(release.archives['win32-x64'].sha256).toBe(
      '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821'
    )
    expect(release.windowsBuildInputs.headersArchive.sha256).toBe(
      '6c7d41d83c3481d2301115b8ce4a44b7d4fbfa52859b1aac14f445d460137887'
    )
  })

  it('accepts only the exact immutable runtime and Windows-build input contract', () => {
    expect(validateSshRelayNodeReleaseContract(contract()).nodeVersion).toBe('24.18.0')

    expect(() =>
      validateSshRelayNodeReleaseContract(contract({ baseUrl: 'https://nodejs.org/dist/latest' }))
    ).toThrow(/base URL/i)
    expect(() =>
      validateSshRelayNodeReleaseContract({
        ...contract(),
        archives: { ...archives, 'linux-x64-musl': archives['linux-x64-glibc'] }
      })
    ).toThrow(/archive tuple/i)
    expect(() =>
      validateSshRelayNodeReleaseContract({
        ...contract(),
        archives: { ...archives, 'win32-arm64': { ...archives['win32-arm64'], sha256: 'ABC' } }
      })
    ).toThrow(/SHA-256/i)
    expect(() =>
      validateSshRelayNodeReleaseContract({
        ...contract(),
        windowsBuildInputs: {
          ...windowsBuildInputs,
          headersArchive: { ...windowsBuildInputs.headersArchive, name: 'latest-headers.tar.gz' }
        }
      })
    ).toThrow(/headers archive name/i)
  })

  it('cross-checks every pinned archive against the authenticated checksum document', () => {
    const body = pinnedFiles()
      .map((file) => `${file.sha256}  ${file.name}`)
      .join('\n')
    const release = contract({
      checksumDocument: { ...contract().checksumDocument, sha256: digest(body) }
    })

    expect(verifySshRelayNodeChecksumDocument(release, Buffer.from(body))).toHaveLength(9)
    expect(() =>
      verifySshRelayNodeChecksumDocument(release, Buffer.from(`${body}\n${body.split('\n')[0]}`))
    ).toThrow(/duplicate/i)
    expect(() =>
      verifySshRelayNodeChecksumDocument(
        release,
        Buffer.from(body.replace('1'.repeat(64), 'f'.repeat(64)))
      )
    ).toThrow(/checksum document SHA-256/i)
  })

  it('streams and bounds the exact archive before accepting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-node-release-test-'))
    temporaryDirectories.push(directory)
    const archivePath = join(directory, archives['linux-x64-glibc'].name)
    await writeFile(archivePath, 'verified archive fixture')
    const release = contract({
      maximumArchiveBytes: 64,
      archives: {
        ...archives,
        'linux-x64-glibc': {
          ...archives['linux-x64-glibc'],
          sha256: digest('verified archive fixture')
        }
      }
    })

    await expect(
      verifySshRelayNodeArchive(release, 'linux-x64-glibc', archivePath)
    ).resolves.toMatchObject({ bytes: 24 })
    await writeFile(archivePath, 'x'.repeat(65))
    await expect(
      verifySshRelayNodeArchive(release, 'linux-x64-glibc', archivePath)
    ).rejects.toThrow(/size limit/i)
  })

  it('requires gpgv success and the exact pinned signing fingerprint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-node-signature-test-'))
    temporaryDirectories.push(directory)
    const keyPath = join(directory, 'release-key.asc')
    const checksumPath = join(directory, 'SHASUMS256.txt')
    const signaturePath = join(directory, 'SHASUMS256.txt.sig')
    await writeFile(keyPath, 'key')
    await writeFile(checksumPath, 'checksums')
    await writeFile(signaturePath, 'signature')
    const release = contract({
      checksumDocument: { ...contract().checksumDocument, sha256: digest('checksums') },
      signature: {
        ...contract().signature,
        sha256: digest('signature'),
        key: { ...contract().signature.key, path: keyPath, sha256: digest('key') }
      }
    })
    const commandRunner = async () => ({
      exitCode: 0,
      stdout:
        '[GNUPG:] VALIDSIG C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C 2026-07-14 0 4 0 1 8 00 C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C\n',
      stderr: ''
    })

    await expect(
      verifySshRelayNodeSignature(release, {
        checksumPath,
        signaturePath,
        commandRunner
      })
    ).resolves.toMatchObject({ signerFingerprint: release.signature.signerFingerprint })
    await expect(
      verifySshRelayNodeSignature(release, {
        checksumPath,
        signaturePath,
        commandRunner: async () => ({ exitCode: 1, stdout: '', stderr: 'BAD signature' })
      })
    ).rejects.toThrow(/gpgv/i)

    await expect(
      verifySshRelayNodeSignature(release, {
        checksumPath,
        signaturePath,
        commandRunner: async () => ({
          exitCode: 0,
          stdout: `[GNUPG:] VALIDSIG ${'D'.repeat(40)} 2026-07-14 0 4 0 1 8 00 ${'D'.repeat(40)}\n`,
          stderr: ''
        })
      })
    ).rejects.toThrow(/pinned Node release signer fingerprint/i)
  })

  it('keeps GPG verified-copy paths relative to the exclusive working directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-node-signature-path-test-'))
    temporaryDirectories.push(directory)
    const keyPath = join(directory, 'release-key.asc')
    const checksumPath = join(directory, 'SHASUMS256.txt')
    const signaturePath = join(directory, 'SHASUMS256.txt.sig')
    await writeFile(keyPath, 'key')
    await writeFile(checksumPath, 'checksums')
    await writeFile(signaturePath, 'signature')
    const release = contract({
      checksumDocument: { ...contract().checksumDocument, sha256: digest('checksums') },
      signature: {
        ...contract().signature,
        sha256: digest('signature'),
        key: { ...contract().signature.key, path: keyPath, sha256: digest('key') }
      }
    })
    const calls = []
    const commandRunner = async (command, args, options) => {
      calls.push({ command, args, options })
      return {
        exitCode: 0,
        stdout:
          command === 'gpgv'
            ? `[GNUPG:] VALIDSIG ${release.signature.signerFingerprint} signed fixture\n`
            : '',
        stderr: ''
      }
    }

    await verifySshRelayNodeSignature(release, { checksumPath, signaturePath, commandRunner })

    expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([
      {
        command: 'gpg',
        args: [
          '--batch',
          '--yes',
          '--dearmor',
          '--output',
          './release-key.gpg',
          './release-key.asc'
        ]
      },
      {
        command: 'gpgv',
        args: [
          '--status-fd',
          '1',
          '--keyring',
          './release-key.gpg',
          './SHASUMS256.txt.sig',
          './SHASUMS256.txt'
        ]
      }
    ])
    expect(calls[0].options.cwd).toMatch(/orca-node-signature-/)
    expect(calls[1].options.cwd).toBe(calls[0].options.cwd)
  })

  it('verifies a Windows archive, headers, and import library through the CLI API', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-node-cli-test-'))
    temporaryDirectories.push(directory)
    const inputsDirectory = join(directory, 'inputs')
    await mkdir(inputsDirectory)
    const keyPath = join(directory, 'release-key.asc')
    const archiveBytes = Buffer.from('archive bytes')
    const headersBytes = Buffer.from('headers archive bytes')
    const libraryBytes = Buffer.from('import library bytes')
    const checksumBody = pinnedFiles()
      .map((file) => {
        const sha256 =
          file.name === archives['win32-x64'].name
            ? digest(archiveBytes)
            : file.name === windowsBuildInputs.headersArchive.name
              ? digest(headersBytes)
              : file.name === windowsBuildInputs.importLibraries['win32-x64'].name
                ? digest(libraryBytes)
                : file.sha256
        return `${sha256}  ${file.name}`
      })
      .join('\n')
    const signatureBytes = Buffer.from('signature bytes')
    const release = contract({
      checksumDocument: { ...contract().checksumDocument, sha256: digest(checksumBody) },
      signature: {
        ...contract().signature,
        sha256: digest(signatureBytes),
        key: { ...contract().signature.key, path: keyPath, sha256: digest('release key') }
      },
      archives: {
        ...archives,
        'win32-x64': {
          ...archives['win32-x64'],
          sha256: digest(archiveBytes)
        }
      },
      windowsBuildInputs: {
        headersArchive: {
          ...windowsBuildInputs.headersArchive,
          sha256: digest(headersBytes)
        },
        importLibraries: {
          ...windowsBuildInputs.importLibraries,
          'win32-x64': {
            ...windowsBuildInputs.importLibraries['win32-x64'],
            sha256: digest(libraryBytes)
          }
        }
      }
    })
    const contractPath = join(directory, 'release.json')
    await mkdir(join(inputsDirectory, 'win-x64'))
    await Promise.all([
      writeFile(contractPath, JSON.stringify(release)),
      writeFile(keyPath, 'release key'),
      writeFile(join(inputsDirectory, release.checksumDocument.name), checksumBody),
      writeFile(join(inputsDirectory, release.signature.name), signatureBytes),
      writeFile(join(inputsDirectory, release.archives['win32-x64'].name), archiveBytes),
      writeFile(
        join(inputsDirectory, release.windowsBuildInputs.headersArchive.name),
        headersBytes
      ),
      writeFile(join(inputsDirectory, 'win-x64', 'node.lib'), libraryBytes)
    ])
    const commandRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: `[GNUPG:] VALIDSIG ${release.signature.signerFingerprint} signed metadata\n`,
      stderr: ''
    }))

    const result = await verifyNodeReleaseInputs(
      { contractPath, inputsDirectory, archiveTuples: ['win32-x64'] },
      { commandRunner }
    )

    expect(result).toMatchObject({
      nodeVersion: release.nodeVersion,
      signerFingerprint: release.signature.signerFingerprint,
      checksumEntriesVerified: 9,
      archives: [{ tuple: 'win32-x64', bytes: archiveBytes.length }],
      windowsBuildInputs: [
        { kind: 'headers', bytes: headersBytes.length },
        { kind: 'import-library', tuple: 'win32-x64', bytes: libraryBytes.length }
      ]
    })
    expect(commandRunner).toHaveBeenCalledTimes(2)
  })

  it('rejects ambiguous or unknown CLI archive scopes', () => {
    expect(
      parseArguments(['--inputs-directory', '/tmp/node-inputs', '--archive', 'linux-x64-glibc'])
    ).toMatchObject({ archiveTuples: ['linux-x64-glibc'] })
    expect(() =>
      parseArguments([
        '--inputs-directory',
        '/tmp/node-inputs',
        '--archive',
        'linux-x64-glibc',
        '--all-archives'
      ])
    ).toThrow(/cannot be combined/i)
    expect(() =>
      parseArguments(['--inputs-directory', '/tmp/node-inputs', '--archive', 'linux-x64-musl'])
    ).toThrow(/unknown archive tuple/i)
  })
})
