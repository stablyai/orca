import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexAppServerCapabilityCache } from './codex-app-server-capability-cache'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'
import type { CodexUserHookTrustRebaseRequest } from './codex-user-hook-trust-rebase-client'
import {
  _internals,
  clearHookTrustKeySeparatorVariants,
  resolveMirroredRuntimeUserHookTrustEntries,
  stampMirroredRuntimeTrustWithCurrentHashes
} from './codex-mirrored-hook-runtime-trust'
import {
  computeTrustKey,
  getHookTrustKeyWriteVariants,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

const SYSTEM_HASH = 'sha256:system-source-hash'
const RUNTIME_HASH = 'sha256:runtime-current-hash'

function windowsUserHookEntry(trustedHash = SYSTEM_HASH): CodexTrustEntry {
  return {
    sourcePath: 'C:\\Users\\Rod\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\hooks.json',
    eventLabel: 'pre_tool_use',
    groupIndex: 1,
    handlerIndex: 0,
    command: 'user-pre-tool-hook',
    trustedHash
  }
}

function grantFor(entry: CodexTrustEntry, currentHash = RUNTIME_HASH) {
  return { key: computeTrustKey(entry), command: entry.command, currentHash }
}

function inspected(request: CodexUserHookTrustRebaseRequest, currentHash = SYSTEM_HASH) {
  if (request.operation !== 'inspect-user-hook-trust') {
    throw new Error('expected system trust inspection')
  }
  return {
    outcome: 'inspected' as const,
    moves: request.moves.map((move) => ({
      ...move,
      reportedOldKey: move.oldKey,
      currentHash,
      wasTrusted: true,
      enabled: true
    }))
  }
}

describe('stampMirroredRuntimeTrustWithCurrentHashes', () => {
  it('replaces the approved system hash only for an exact runtime key and command match', () => {
    const entry = windowsUserHookEntry()
    const slashKey =
      'C:/Users/Rod/AppData/Roaming/orca/codex-runtime-home/home/hooks.json:pre_tool_use:1:0'
    expect(
      stampMirroredRuntimeTrustWithCurrentHashes(
        [entry],
        [{ key: slashKey, command: entry.command, currentHash: RUNTIME_HASH }]
      )[0]?.trustedHash
    ).toBe(RUNTIME_HASH)
    expect(
      stampMirroredRuntimeTrustWithCurrentHashes(
        [entry],
        [{ key: slashKey, command: 'some-other-hook', currentHash: RUNTIME_HASH }]
      )[0]?.trustedHash
    ).toBe(SYSTEM_HASH)
  })
})

describe('mirrored runtime hook trust', () => {
  let tmpDir: string
  let tomlPath: string
  let runtimeHomePath: string
  let systemHomePath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-mirrored-hook-trust-'))
    runtimeHomePath = join(tmpDir, 'home')
    systemHomePath = join(tmpDir, 'system-home')
    tomlPath = join(runtimeHomePath, 'config.toml')
    mkdirSync(runtimeHomePath, { recursive: true })
    writeFileSync(tomlPath, 'model = "runtime"\n', 'utf-8')
    codexAppServerCapabilityCache.clear()
    _internals.resetState()
    _internals.setHostResolver(async (host) => ({
      binaryStamp:
        host.kind === 'native'
          ? { kind: 'native', path: '/codex', size: 1, mtimeMs: 1 }
          : { kind: 'wsl', distro: host.distro, path: '/usr/bin/codex', version: '1' },
      buildRequest: (input) => ({
        invocation: { command: 'codex', cliPath: null, args: [], timeoutMs: 1_000 },
        hooksListCwd: input.runtimeHomePath,
        expectedTrustKeys: input.expectedTrustKeys,
        managedCommand: input.managedCommand
      })
    }))
  })

  function systemEntryFor(entry: CodexTrustEntry): CodexTrustEntry {
    return { ...entry, sourcePath: join(systemHomePath, 'hooks.json') }
  }

  function resolveArgs(entry: CodexTrustEntry, home = runtimeHomePath, config = tomlPath) {
    return {
      entries: [entry],
      systemEntries: [systemEntryFor(entry)],
      systemHomePath,
      runtimeHomePath: home,
      tomlPath: config
    }
  }

  afterEach(() => {
    _internals.setSessionRunner(null)
    _internals.setHostResolver(null)
    _internals.setConfigRestorer(null)
    _internals.resetState()
    codexAppServerCapabilityCache.clear()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('clears both Windows separator variants before writing the verified runtime hash', () => {
    const entry = windowsUserHookEntry()
    const backslashKey = computeTrustKey(entry)
    const slashKey = backslashKey.replaceAll('\\', '/')
    writeFileSync(
      tomlPath,
      [
        `[hooks.state.'${backslashKey}']`,
        `trusted_hash = "${SYSTEM_HASH}"`,
        '',
        `[hooks.state.'${slashKey}']`,
        'trusted_hash = "sha256:other-separator-hash"',
        ''
      ].join('\n'),
      'utf-8'
    )

    expect(getHookTrustKeyWriteVariants(backslashKey)).toEqual(
      expect.arrayContaining([backslashKey, slashKey])
    )
    clearHookTrustKeySeparatorVariants(tomlPath, [backslashKey])
    upsertHookTrustEntries(tomlPath, [{ ...entry, trustedHash: RUNTIME_HASH }])

    const written = readFileSync(tomlPath, 'utf-8')
    expect((written.match(/trusted_hash = "sha256:runtime-current-hash"/g) ?? []).length).toBe(2)
    expect(written).not.toContain(SYSTEM_HASH)
    expect(written).not.toContain('sha256:other-separator-hash')
  })

  it('returns only a hash verified through the app-server grant session', async () => {
    const entry: CodexTrustEntry = {
      sourcePath: join(runtimeHomePath, 'hooks.json'),
      eventLabel: 'pre_tool_use',
      groupIndex: 1,
      handlerIndex: 0,
      command: 'user-pre-tool-hook',
      trustedHash: SYSTEM_HASH
    }
    const runner = vi.fn(async (request: CodexUserHookTrustRebaseRequest) => {
      if (request.operation === 'inspect-user-hook-trust') {
        return inspected(request)
      }
      upsertHookTrustEntries(tomlPath, [{ ...entry, trustedHash: RUNTIME_HASH }])
      return { outcome: 'mirrored-granted' as const, entries: [grantFor(entry)] }
    })
    _internals.setSessionRunner(runner)

    const resolved = await resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))

    expect(resolved[0]?.trustedHash).toBe(RUNTIME_HASH)
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('does not grant runtime trust when the stored system hash is stale for edited content', async () => {
    const entry: CodexTrustEntry = {
      sourcePath: join(runtimeHomePath, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 1,
      handlerIndex: 0,
      command: 'edited-user-hook',
      trustedHash: SYSTEM_HASH
    }
    const runner = vi.fn(async (request: CodexUserHookTrustRebaseRequest) =>
      inspected(request, 'sha256:edited-system-current-hash')
    )
    _internals.setSessionRunner(runner)

    const resolved = await resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))
    const repeated = await resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))

    expect(resolved[0]?.trustedHash).toBe(SYSTEM_HASH)
    expect(repeated[0]?.trustedHash).toBe(SYSTEM_HASH)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('restores the exact runtime TOML snapshot when the verified grant fails', async () => {
    const entry: CodexTrustEntry = {
      sourcePath: join(runtimeHomePath, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 1,
      handlerIndex: 0,
      command: 'user-stop-hook',
      trustedHash: SYSTEM_HASH
    }
    const original = 'model = "runtime"\r\n# keep exact bytes\r\n'
    writeFileSync(tomlPath, original, 'utf-8')
    _internals.setSessionRunner(async (request) => {
      if (request.operation === 'inspect-user-hook-trust') {
        return inspected(request)
      }
      upsertHookTrustEntries(tomlPath, [{ ...entry, trustedHash: RUNTIME_HASH }])
      throw new Error('post-write verification failed')
    })

    await resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))

    expect(readFileSync(tomlPath, 'utf-8')).toBe(original)
  })

  it('surfaces a rollback failure instead of accepting the partially written hash', async () => {
    const entry: CodexTrustEntry = {
      sourcePath: join(runtimeHomePath, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 1,
      handlerIndex: 0,
      command: 'user-stop-hook',
      trustedHash: SYSTEM_HASH
    }
    _internals.setSessionRunner(async (request) => {
      if (request.operation === 'inspect-user-hook-trust') {
        return inspected(request)
      }
      upsertHookTrustEntries(tomlPath, [{ ...entry, trustedHash: RUNTIME_HASH }])
      throw new Error('post-write verification failed')
    })
    _internals.setConfigRestorer(() => {
      throw new Error('restore failed')
    })

    await expect(resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))).rejects.toThrow(
      'failed to restore runtime hook trust'
    )
  })

  it('reuses a verified fingerprint but isolates it by managed account home', async () => {
    const entry: CodexTrustEntry = {
      sourcePath: join(runtimeHomePath, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 1,
      handlerIndex: 0,
      command: 'user-stop-hook',
      trustedHash: SYSTEM_HASH
    }
    let activeTomlPath = tomlPath
    let activeEntry = entry
    const runner = vi.fn(async (request: CodexUserHookTrustRebaseRequest) => {
      if (request.operation === 'inspect-user-hook-trust') {
        return inspected(request)
      }
      upsertHookTrustEntries(activeTomlPath, [{ ...activeEntry, trustedHash: RUNTIME_HASH }])
      return { outcome: 'mirrored-granted' as const, entries: [grantFor(activeEntry)] }
    })
    _internals.setSessionRunner(runner)

    await resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))
    await resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))
    expect(runner).toHaveBeenCalledTimes(2)

    const secondHome = join(tmpDir, 'second-home')
    const secondToml = join(secondHome, 'config.toml')
    mkdirSync(secondHome, { recursive: true })
    writeFileSync(secondToml, 'model = "runtime"\n', 'utf-8')
    activeTomlPath = secondToml
    activeEntry = { ...entry, sourcePath: join(secondHome, 'hooks.json') }
    await resolveMirroredRuntimeUserHookTrustEntries(
      resolveArgs(activeEntry, secondHome, secondToml)
    )
    expect(runner).toHaveBeenCalledTimes(4)
  })

  it('does not reuse a verified fingerprint without a binary identity', async () => {
    const entry: CodexTrustEntry = {
      sourcePath: join(runtimeHomePath, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 1,
      handlerIndex: 0,
      command: 'user-stop-hook',
      trustedHash: SYSTEM_HASH
    }
    _internals.setHostResolver(async () => ({
      binaryStamp: null,
      buildRequest: (input) => ({
        invocation: { command: 'codex', cliPath: null, args: [], timeoutMs: 1_000 },
        hooksListCwd: input.runtimeHomePath,
        expectedTrustKeys: input.expectedTrustKeys,
        managedCommand: input.managedCommand
      })
    }))
    const runner = vi.fn(async (request: CodexUserHookTrustRebaseRequest) => {
      if (request.operation === 'inspect-user-hook-trust') {
        return inspected(request)
      }
      upsertHookTrustEntries(tomlPath, [{ ...entry, trustedHash: RUNTIME_HASH }])
      return { outcome: 'mirrored-granted' as const, entries: [grantFor(entry)] }
    })
    _internals.setSessionRunner(runner)

    await resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))
    await resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))

    expect(runner).toHaveBeenCalledTimes(4)
  })

  it('keeps transient cooldown isolated by account and unsupported cooldown isolated by host', async () => {
    const entry: CodexTrustEntry = {
      sourcePath: join(runtimeHomePath, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 1,
      handlerIndex: 0,
      command: 'user-stop-hook',
      trustedHash: SYSTEM_HASH
    }
    let transient = true
    const runner = vi.fn(async (request: CodexUserHookTrustRebaseRequest) => {
      if (transient) {
        transient = false
        throw new Error('transient')
      }
      if (request.operation === 'inspect-user-hook-trust') {
        return inspected(request)
      }
      return { outcome: 'mirrored-granted' as const, entries: [grantFor(entry)] }
    })
    _internals.setSessionRunner(runner)

    await resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))
    await resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))
    expect(runner).toHaveBeenCalledTimes(1)

    const secondHome = join(tmpDir, 'second-home')
    const secondToml = join(secondHome, 'config.toml')
    mkdirSync(secondHome, { recursive: true })
    writeFileSync(secondToml, 'model = "runtime"\n', 'utf-8')
    const secondEntry = { ...entry, sourcePath: join(secondHome, 'hooks.json') }
    await resolveMirroredRuntimeUserHookTrustEntries(
      resolveArgs(secondEntry, secondHome, secondToml)
    )
    expect(runner).toHaveBeenCalledTimes(3)

    _internals.resetState()
    codexAppServerCapabilityCache.clear()
    runner.mockImplementation(async () => {
      throw new CodexAppServerUnsupportedError('method not found')
    })
    await resolveMirroredRuntimeUserHookTrustEntries(resolveArgs(entry))
    await resolveMirroredRuntimeUserHookTrustEntries(
      resolveArgs(secondEntry, secondHome, secondToml)
    )
    expect(runner).toHaveBeenCalledTimes(4)

    await resolveMirroredRuntimeUserHookTrustEntries({
      ...resolveArgs(secondEntry, secondHome, secondToml),
      host: { kind: 'wsl', distro: 'Ubuntu', linuxRuntimeHome: '/home/rod/.codex' }
    })
    expect(runner).toHaveBeenCalledTimes(5)
  })
})
