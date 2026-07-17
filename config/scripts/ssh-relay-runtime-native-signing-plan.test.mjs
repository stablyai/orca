import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import {
  buildSshRelayRuntimeNativeSigningPlan,
  parseSshRelayRuntimeNativeSigningPlanArguments,
  readSshRelayRuntimeNativeSigningIdentity
} from './ssh-relay-runtime-native-signing-plan.mjs'

const DIGEST = `sha256:${'a'.repeat(64)}`

function identityFor(tupleId) {
  const os = tupleId.startsWith('linux-')
    ? 'linux'
    : tupleId.startsWith('darwin-')
      ? 'darwin'
      : 'win32'
  return {
    tupleId,
    os,
    nodeVersion: '24.18.0',
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries: expectedSshRelayRuntimeClosureEntries(tupleId).map((entry) =>
      entry.type === 'file' ? { ...entry, size: 1, sha256: DIGEST } : entry
    )
  }
}

function paths(entries) {
  return entries.map((entry) => entry.path)
}

describe('SSH relay runtime native signing plan', () => {
  it('keeps official Linux Node immutable and selects no signing targets', () => {
    for (const tupleId of ['linux-x64-glibc', 'linux-arm64-glibc']) {
      const plan = buildSshRelayRuntimeNativeSigningPlan(identityFor(tupleId))
      expect(plan.policy).toBe('linux-hash-only-v1')
      expect(paths(plan.immutableVendorFiles)).toEqual(['bin/node'])
      expect(plan.signingCandidates).toEqual([])
      expect(paths(plan.verificationFiles)).toEqual([
        'bin/node',
        `node_modules/@parcel/watcher-linux-${tupleId.includes('arm64') ? 'arm64' : 'x64'}-glibc/watcher.node`,
        'node_modules/node-pty/build/Release/pty.node'
      ])
    }
  })

  it('selects every non-Node macOS native file for Developer ID signing', () => {
    for (const tupleId of ['darwin-x64', 'darwin-arm64']) {
      const architecture = tupleId.endsWith('arm64') ? 'arm64' : 'x64'
      const plan = buildSshRelayRuntimeNativeSigningPlan(identityFor(tupleId))
      expect(plan.policy).toBe('apple-developer-id-v1')
      expect(paths(plan.immutableVendorFiles)).toEqual(['bin/node'])
      expect(paths(plan.signingCandidates)).toEqual([
        `node_modules/@parcel/watcher-darwin-${architecture}/watcher.node`,
        'node_modules/node-pty/build/Release/pty.node',
        'node_modules/node-pty/build/Release/spawn-helper'
      ])
      expect(
        plan.signingCandidates.every((entry) => entry.action === 'developer-id-required')
      ).toBe(true)
      expect(paths(plan.verificationFiles)).toEqual(['bin/node', ...paths(plan.signingCandidates)])
    }
  })

  it('selects every non-Node Windows PE as a SignPath candidate', () => {
    for (const tupleId of ['win32-x64', 'win32-arm64']) {
      const architecture = tupleId.endsWith('arm64') ? 'arm64' : 'x64'
      const plan = buildSshRelayRuntimeNativeSigningPlan(identityFor(tupleId))
      expect(plan.policy).toBe('signpath-authenticode-v1')
      expect(paths(plan.immutableVendorFiles)).toEqual(['bin/node.exe'])
      expect(paths(plan.signingCandidates)).toEqual([
        `node_modules/@parcel/watcher-win32-${architecture}/watcher.node`,
        'node_modules/node-pty/build/Release/conpty.node',
        'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
        'node_modules/node-pty/build/Release/conpty/conpty.dll',
        'node_modules/node-pty/build/Release/conpty_console_list.node'
      ])
      expect(plan.signingCandidates.every((entry) => entry.action === 'signpath-if-unsigned')).toBe(
        true
      )
      expect(paths(plan.verificationFiles)).toEqual([
        'bin/node.exe',
        ...paths(plan.signingCandidates)
      ])
    }
  })

  it('fails closed on tuple, role, path, and native-count drift', () => {
    const wrongOs = identityFor('darwin-arm64')
    wrongOs.os = 'linux'
    expect(() => buildSshRelayRuntimeNativeSigningPlan(wrongOs)).toThrow(/tuple and OS/i)

    const wrongRole = identityFor('darwin-arm64')
    wrongRole.entries.find((entry) => entry.path.endsWith('/watcher.node')).role =
      'runtime-javascript'
    expect(() => buildSshRelayRuntimeNativeSigningPlan(wrongRole)).toThrow(/unexpected role/i)

    const wrongPath = identityFor('win32-x64')
    wrongPath.entries.find((entry) => entry.path.endsWith('/conpty.node')).path += '.txt'
    expect(() => buildSshRelayRuntimeNativeSigningPlan(wrongPath)).toThrow(/missing required file/i)

    const duplicate = identityFor('linux-x64-glibc')
    duplicate.entries.push(
      structuredClone(duplicate.entries.find((entry) => entry.role === 'node'))
    )
    expect(() => buildSshRelayRuntimeNativeSigningPlan(duplicate)).toThrow(/duplicate file/i)
  })

  it('accepts only one purpose-named identity argument', () => {
    expect(
      parseSshRelayRuntimeNativeSigningPlanArguments(['--identity', './identity.json'])
    ).toEqual({
      identityPath: expect.stringMatching(/identity[.]json$/)
    })
    expect(() => parseSshRelayRuntimeNativeSigningPlanArguments([])).toThrow(/usage/i)
    expect(() =>
      parseSshRelayRuntimeNativeSigningPlanArguments(['--identity', 'a', '--identity', 'b'])
    ).toThrow(/usage/i)
  })

  it('reads only one bounded regular JSON identity file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ssh-relay-native-signing-plan-'))
    try {
      const validPath = join(directory, 'valid.json')
      await writeFile(validPath, JSON.stringify(identityFor('linux-x64-glibc')))
      await expect(readSshRelayRuntimeNativeSigningIdentity(validPath)).resolves.toMatchObject({
        tupleId: 'linux-x64-glibc'
      })

      const malformedPath = join(directory, 'malformed.json')
      await writeFile(malformedPath, '{')
      await expect(readSshRelayRuntimeNativeSigningIdentity(malformedPath)).rejects.toThrow(
        /valid JSON/i
      )

      const oversizedPath = join(directory, 'oversized.json')
      await writeFile(oversizedPath, Buffer.alloc(4 * 1024 * 1024 + 1))
      await expect(readSshRelayRuntimeNativeSigningIdentity(oversizedPath)).rejects.toThrow(
        /bounded/i
      )
      await expect(readSshRelayRuntimeNativeSigningIdentity(directory)).rejects.toThrow(
        /regular file/i
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
