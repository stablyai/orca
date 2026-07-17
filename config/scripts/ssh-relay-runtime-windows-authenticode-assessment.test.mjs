import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import {
  assessSshRelayRuntimeWindowsAuthenticode,
  classifySshRelayRuntimeWindowsAuthenticode,
  getSshRelayRuntimeWindowsAuthenticodeJson,
  parseSshRelayRuntimeWindowsAuthenticodeJson
} from './ssh-relay-runtime-windows-authenticode-assessment.mjs'

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function windowsFixture(tupleId = 'win32-x64') {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-authenticode-assessment-'))
  const runtimeRoot = join(root, 'runtime')
  await mkdir(runtimeRoot)
  const entries = []
  for (const entry of expectedSshRelayRuntimeClosureEntries(tupleId)) {
    if (entry.type === 'directory') {
      await mkdir(join(runtimeRoot, ...entry.path.split('/')), { recursive: true })
      entries.push(entry)
      continue
    }
    const bytes = Buffer.from(`fixture:${tupleId}:${entry.path}`)
    const filePath = join(runtimeRoot, ...entry.path.split('/'))
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, bytes)
    entries.push({ ...entry, size: bytes.length, sha256: digest(bytes) })
  }
  return {
    root,
    runtimeRoot,
    identity: {
      tupleId,
      os: 'win32',
      nodeVersion: '24.18.0',
      dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
      entries
    }
  }
}

function signatureJson({
  status = 'NotSigned',
  signerSubject = null,
  signerThumbprint = null
} = {}) {
  return JSON.stringify({ status, signerSubject, signerThumbprint })
}

describe('SSH relay runtime Windows Authenticode assessment', () => {
  it('classifies only exact unsigned and valid-upstream signature states', () => {
    expect(
      classifySshRelayRuntimeWindowsAuthenticode({
        status: 'NotSigned',
        signerSubject: null,
        signerThumbprint: null
      })
    ).toEqual({ status: 'unsigned' })
    expect(
      classifySshRelayRuntimeWindowsAuthenticode({
        status: 'Valid',
        signerSubject: 'CN=Microsoft Corporation',
        signerThumbprint: 'a'.repeat(40)
      })
    ).toEqual({
      status: 'valid-upstream',
      signerSubject: 'CN=Microsoft Corporation',
      signerThumbprint: 'A'.repeat(40)
    })

    for (const status of ['HashMismatch', 'NotTrusted', 'UnknownError', 'PublisherMismatch']) {
      expect(() =>
        classifySshRelayRuntimeWindowsAuthenticode({
          status,
          signerSubject: null,
          signerThumbprint: null
        })
      ).toThrow(/rejects signature status/i)
    }
  })

  it('rejects malformed JSON, fields, and status-qualified certificate metadata', () => {
    expect(() => parseSshRelayRuntimeWindowsAuthenticodeJson('')).toThrow(/did not return/i)
    expect(() => parseSshRelayRuntimeWindowsAuthenticodeJson('{')).toThrow(/malformed/i)
    expect(() =>
      parseSshRelayRuntimeWindowsAuthenticodeJson(
        JSON.stringify({
          status: 'NotSigned',
          signerSubject: null,
          signerThumbprint: null,
          extra: true
        })
      )
    ).toThrow(/unexpected fields/i)
    expect(() =>
      classifySshRelayRuntimeWindowsAuthenticode({
        status: 'NotSigned',
        signerSubject: 'CN=Unexpected',
        signerThumbprint: null
      })
    ).toThrow(/unsigned.*certificate/i)
    expect(() =>
      classifySshRelayRuntimeWindowsAuthenticode({
        status: 'Valid',
        signerSubject: '',
        signerThumbprint: 'bad'
      })
    ).toThrow(/valid.*certificate/i)
  })

  it('uses a bounded noninteractive PowerShell probe with the path only in the environment', () => {
    const calls = []
    const stdout = signatureJson()
    const result = getSshRelayRuntimeWindowsAuthenticodeJson(
      'C:\\Path With Spaces\\candidate.node',
      (command, args, options) => {
        calls.push({ command, args, options })
        return { status: 0, stdout, stderr: '' }
      }
    )

    expect(result).toBe(stdout)
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('pwsh')
    expect(calls[0].args).toEqual(
      expect.arrayContaining(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    )
    expect(calls[0].args.join(' ')).not.toContain('Path With Spaces')
    expect(calls[0].options).toEqual(
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: expect.objectContaining({
          ORCA_SSH_RELAY_AUTHENTICODE_FILE: 'C:\\Path With Spaces\\candidate.node'
        })
      })
    )
  })

  it('fails on probe errors, stderr, nonzero exit, or empty output', () => {
    expect(() =>
      getSshRelayRuntimeWindowsAuthenticodeJson('candidate.node', () => ({
        error: new Error('timed out'),
        status: null,
        stdout: '',
        stderr: ''
      }))
    ).toThrow(/timed out/i)
    expect(() =>
      getSshRelayRuntimeWindowsAuthenticodeJson('candidate.node', () => ({
        status: 0,
        stdout: signatureJson(),
        stderr: 'warning'
      }))
    ).toThrow(/stderr/i)
    expect(() =>
      getSshRelayRuntimeWindowsAuthenticodeJson('candidate.node', () => ({
        status: 7,
        stdout: '',
        stderr: ''
      }))
    ).toThrow(/exit code 7/i)
    expect(() =>
      getSshRelayRuntimeWindowsAuthenticodeJson('candidate.node', () => ({
        status: 0,
        stdout: '',
        stderr: ''
      }))
    ).toThrow(/did not return/i)
  })

  it('hash-binds and assesses every exact Windows signing candidate', async () => {
    const fixture = await windowsFixture()
    const calls = []
    try {
      const assessments = await assessSshRelayRuntimeWindowsAuthenticode({
        identity: fixture.identity,
        runtimeRoot: fixture.runtimeRoot,
        platform: 'win32',
        spawnSyncImpl: (_command, _args, options) => {
          calls.push(options.env.ORCA_SSH_RELAY_AUTHENTICODE_FILE)
          const isUpstream =
            options.env.ORCA_SSH_RELAY_AUTHENTICODE_FILE.endsWith('OpenConsole.exe')
          return {
            status: 0,
            stdout: isUpstream
              ? signatureJson({
                  status: 'Valid',
                  signerSubject: 'CN=Microsoft Corporation',
                  signerThumbprint: 'b'.repeat(40)
                })
              : signatureJson(),
            stderr: ''
          }
        }
      })

      expect(assessments).toHaveLength(5)
      expect(calls).toHaveLength(5)
      expect(assessments.find((entry) => entry.status === 'valid-upstream')).toEqual(
        expect.objectContaining({
          path: 'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
          signerSubject: 'CN=Microsoft Corporation',
          signerThumbprint: 'B'.repeat(40)
        })
      )
      expect(assessments.filter((entry) => entry.status === 'unsigned')).toHaveLength(4)
      for (const assessment of assessments) {
        expect(assessment.sourceSha256).toMatch(/^sha256:[0-9a-f]{64}$/)
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects host mismatch and source mutation before the first probe', async () => {
    const fixture = await windowsFixture('win32-arm64')
    let calls = 0
    const spawnSyncImpl = () => {
      calls += 1
      return { status: 0, stdout: signatureJson(), stderr: '' }
    }
    try {
      await expect(
        assessSshRelayRuntimeWindowsAuthenticode({
          identity: fixture.identity,
          runtimeRoot: fixture.runtimeRoot,
          platform: 'darwin',
          spawnSyncImpl
        })
      ).rejects.toThrow(/requires Windows/i)

      const candidate = fixture.identity.entries.find(
        (entry) => entry.type === 'file' && entry.role === 'node-pty-native'
      )
      await writeFile(join(fixture.runtimeRoot, ...candidate.path.split('/')), 'mutated')
      await expect(
        assessSshRelayRuntimeWindowsAuthenticode({
          identity: fixture.identity,
          runtimeRoot: fixture.runtimeRoot,
          platform: 'win32',
          spawnSyncImpl
        })
      ).rejects.toThrow(/authenticated (size|hash)/i)
      expect(calls).toBe(0)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a candidate changed during its PowerShell assessment', async () => {
    const fixture = await windowsFixture()
    let calls = 0
    try {
      await expect(
        assessSshRelayRuntimeWindowsAuthenticode({
          identity: fixture.identity,
          runtimeRoot: fixture.runtimeRoot,
          platform: 'win32',
          spawnSyncImpl: (_command, _args, options) => {
            calls += 1
            writeFileSync(options.env.ORCA_SSH_RELAY_AUTHENTICODE_FILE, 'changed-during-probe')
            return { status: 0, stdout: signatureJson(), stderr: '' }
          }
        })
      ).rejects.toThrow(/changed during assessment/i)
      expect(calls).toBe(1)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked candidate before PowerShell',
    async () => {
      const fixture = await windowsFixture()
      try {
        const candidate = fixture.identity.entries.find(
          (entry) => entry.type === 'file' && entry.role === 'node-pty-native'
        )
        const candidatePath = join(fixture.runtimeRoot, ...candidate.path.split('/'))
        const target = join(fixture.root, 'candidate-target')
        await writeFile(target, await readFile(candidatePath))
        await rm(candidatePath)
        await symlink(target, candidatePath)
        await expect(
          assessSshRelayRuntimeWindowsAuthenticode({
            identity: fixture.identity,
            runtimeRoot: fixture.runtimeRoot,
            platform: 'win32',
            spawnSyncImpl: () => {
              throw new Error('should not probe')
            }
          })
        ).rejects.toThrow(/symbolic link/i)
        expect((await lstat(candidatePath)).isSymbolicLink()).toBe(true)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    }
  )
})
