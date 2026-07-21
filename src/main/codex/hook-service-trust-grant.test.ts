import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { wrapPosixHookCommand } from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  computeTrustedHash,
  escapeTomlString,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { codexAppServerCapabilityCache } from './codex-app-server-capability-cache'
import { _internals as trustGrantInternals } from './codex-hook-trust-grant'
import {
  readCodexTrustGrantLedgerHome,
  writeCodexTrustGrantLedgerHome
} from './codex-trust-grant-ledger'
import type { CodexHookTrustGrantRequest } from './codex-app-server-client'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import { _internals as rebaseInternals } from './codex-user-hook-trust-rebase'

const { getPathMock, homedirMock, resolveCodexCommandMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>(),
  resolveCodexCommandMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: resolveCodexCommandMock }))

import { CodexHookService, getCodexManagedHookInstallMaterial } from './hook-service'

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined
let previousDisableTrustRpc: string | undefined

beforeEach(() => {
  previousDisableTrustRpc = process.env.ORCA_DISABLE_CODEX_TRUST_RPC
  delete process.env.ORCA_DISABLE_CODEX_TRUST_RPC
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
  resolveCodexCommandMock.mockReturnValue(process.execPath)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  trustGrantInternals.resetDiagnostics()
  codexAppServerCapabilityCache.clear()
})

afterEach(() => {
  rebaseInternals.setSessionRunnerSync(null)
  trustGrantInternals.setGrantSessionRunnerSync(null)
  trustGrantInternals.resetDiagnostics()
  codexAppServerCapabilityCache.clear()
  if (previousDisableTrustRpc === undefined) {
    delete process.env.ORCA_DISABLE_CODEX_TRUST_RPC
  } else {
    process.env.ORCA_DISABLE_CODEX_TRUST_RPC = previousDisableTrustRpc
  }
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

// Why: model codex's own config/batchWrite — exactly one
// `[hooks.state."<key>"]` table per reported key, keyed verbatim, blank-line
// separated (the shape the real 0.144.x binary writes). Orca's
// upsertHookTrustEntries writes BOTH separator variants for a Windows key (a
// fallback-lane compat shim real codex never does), which would fabricate
// duplicate tables on win32 that the RPC path never produces.
function writeCodexLikeTrust(configPath: string, entries: CodexTrustEntry[]): void {
  let content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
  if (!/^\[hooks\.state\][ \t]*$/m.test(content)) {
    const separator = content.length === 0 ? '' : content.endsWith('\n') ? '' : '\n'
    content += `${separator}[hooks.state]\n`
  }
  for (const entry of entries) {
    const header = `[hooks.state."${escapeTomlString(computeTrustKey(entry))}"]`
    // Why: replace any existing table for this exact key so re-grants upgrade
    // in place instead of duplicating (mirrors codex's upsert merge strategy).
    const existingBlock = new RegExp(
      `(?:\\n)?${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n(?:[^[\\n].*\\n?|\\n)*`,
      'g'
    )
    content = content.replace(existingBlock, '')
    content += `${content.endsWith('\n') ? '' : '\n'}\n${header}\ntrusted_hash = "${escapeTomlString(entry.trustedHash!)}"\n`
  }
  writeFileSync(configPath, content)
}

function installCodexLikeGrantRunner(): ReturnType<typeof vi.fn> {
  const codexHash = (key: string): string =>
    `sha256:codex-${parseTrustKey(key)?.eventLabel ?? 'unknown'}`
  const runner = vi.fn((request: CodexHookTrustGrantRequest) => {
    const codexHome = request.invocation.env?.CODEX_HOME
    expect(codexHome).toBeTruthy()
    const entries: CodexTrustEntry[] = request.expectedTrustKeys.map((key) => {
      const parsed = parseTrustKey(key)!
      return {
        ...parsed,
        command: request.managedCommand,
        trustedHash: codexHash(key)
      }
    })
    writeCodexLikeTrust(join(codexHome!, 'config.toml'), entries)
    return {
      outcome: 'granted' as const,
      wroteTrust: true,
      entries: request.expectedTrustKeys.map((key) => ({
        key,
        normalizedKey: key,
        trustedHash: codexHash(key)
      }))
    }
  })
  trustGrantInternals.setGrantSessionRunnerSync(runner)
  return runner
}

function prepareSystemHome(): void {
  mkdirSync(join(tmpHome, '.codex'), { recursive: true })
}

describe('CodexHookService app-server trust grant lane', () => {
  it('treats Codex hashes as authoritative and records the verified grant', () => {
    prepareSystemHome()
    const runner = installCodexLikeGrantRunner()

    const status = new CodexHookService().install()

    expect(status.state).toBe('installed')
    expect(runner).toHaveBeenCalledTimes(1)
    const managedHome = join(userDataDir, 'codex-runtime-home', 'home')
    const trustConfig = readFileSync(join(managedHome, 'config.toml'), 'utf-8')
    expect(trustConfig).toContain('sha256:codex-session_start')
    const selfComputed = computeTrustedHash({
      sourcePath: join(managedHome, 'hooks.json'),
      eventLabel: 'session_start',
      groupIndex: 0,
      handlerIndex: 0,
      command: wrapPosixHookCommand(join(tmpHome, '.orca', 'agent-hooks', 'codex-hook.sh')),
      timeoutSec: 10
    })
    expect(trustConfig).not.toContain(selfComputed)
    expect(Object.keys(readCodexTrustGrantLedgerHome(managedHome)!.entries)).toHaveLength(6)
  })

  it('keeps config byte-stable and skips the session on a repeat ledger hit', () => {
    prepareSystemHome()
    const runner = installCodexLikeGrantRunner()
    const service = new CodexHookService()
    expect(service.install().state).toBe('installed')
    const managedHome = join(userDataDir, 'codex-runtime-home', 'home')
    const firstToml = readFileSync(join(managedHome, 'config.toml'))

    expect(service.install().state).toBe('installed')
    expect(runner).toHaveBeenCalledTimes(1)
    // Why: each launch validates the binary stamp once; getStatus reuses the
    // just-verified grant instead of repeating PATH/version-manager scans.
    expect(resolveCodexCommandMock).toHaveBeenCalledTimes(2)
    expect(readFileSync(join(managedHome, 'config.toml'))).toEqual(firstToml)
  })

  it('retries ledger-proven real-home trust cleanup after the hook is already gone', () => {
    prepareSystemHome()
    const systemHome = join(tmpHome, '.codex')
    const hooksPath = join(systemHome, 'hooks.json')
    const configPath = join(systemHome, 'config.toml')
    const material = getCodexManagedHookInstallMaterial()
    const trustedHash = 'sha256:codex-real-home-stop'
    const entry: CodexTrustEntry = {
      sourcePath: hooksPath,
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: material.command,
      timeoutSec: 10,
      trustedHash
    }
    const trustKey = computeTrustKey(entry)
    writeFileSync(hooksPath, `${JSON.stringify({ hooks: {} }, null, 2)}\n`)
    upsertHookTrustEntries(configPath, [entry])
    writeCodexTrustGrantLedgerHome(systemHome, {
      binary: null,
      entries: {
        [normalizeHookTrustKeyForLookup(trustKey)]: {
          signature: getCodexHookTrustSignature(entry),
          trustedHash
        }
      }
    })
    installCodexLikeGrantRunner()

    expect(new CodexHookService().install().state).toBe('installed')

    expect(readHookTrustEntries(configPath).has(trustKey)).toBe(false)
    expect(readCodexTrustGrantLedgerHome(systemHome)).toBeNull()
  })

  // Why: ordinary Windows CI tokens cannot create file symlinks without Developer Mode.
  it.skipIf(process.platform === 'win32')(
    'keeps a real-home symlink and rebases later user trust during flag-off cleanup',
    () => {
      prepareSystemHome()
      const systemHome = join(tmpHome, '.codex')
      const hooksPath = join(systemHome, 'hooks.json')
      const targetPath = join(tmpHome, 'dotfiles-hooks.json')
      const material = getCodexManagedHookInstallMaterial()
      const userHook = { type: 'command' as const, command: 'after-orca.sh' }
      writeFileSync(
        targetPath,
        `${JSON.stringify(
          {
            hooks: {
              Stop: [
                { hooks: [{ type: 'command', command: material.command }] },
                { hooks: [userHook] }
              ]
            }
          },
          null,
          2
        )}\n`
      )
      symlinkSync(targetPath, hooksPath)
      const operations: string[] = []
      rebaseInternals.setSessionRunnerSync((request) => {
        operations.push(request.operation)
        if (request.operation === 'inspect-user-hook-trust') {
          return {
            outcome: 'inspected',
            moves: request.moves.map((move) => ({
              ...move,
              reportedOldKey: move.oldKey,
              wasTrusted: true,
              enabled: true
            }))
          }
        }
        return { outcome: 'repaired', repaired: 1 }
      })
      installCodexLikeGrantRunner()

      expect(new CodexHookService().install().state).toBe('installed')

      expect(lstatSync(hooksPath).isSymbolicLink()).toBe(true)
      expect(JSON.parse(readFileSync(targetPath, 'utf-8')).hooks.Stop).toEqual([
        { hooks: [userHook] }
      ])
      expect(operations).toEqual(['inspect-user-hook-trust', 'repair-user-hook-trust'])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'preserves restrictive real-home hooks permissions during flag-off cleanup',
    () => {
      prepareSystemHome()
      const hooksPath = join(tmpHome, '.codex', 'hooks.json')
      const material = getCodexManagedHookInstallMaterial()
      writeFileSync(
        hooksPath,
        `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: material.command }] }] } }, null, 2)}\n`
      )
      chmodSync(hooksPath, 0o600)
      installCodexLikeGrantRunner()

      expect(new CodexHookService().install().state).toBe('installed')

      expect(statSync(hooksPath).mode & 0o777).toBe(0o600)
    }
  )

  it('does not accept a ledger hash after the recorded Codex binary stamp changes', () => {
    prepareSystemHome()
    installCodexLikeGrantRunner()
    const service = new CodexHookService()
    expect(service.install().state).toBe('installed')
    const managedHome = join(userDataDir, 'codex-runtime-home', 'home')
    const ledger = readCodexTrustGrantLedgerHome(managedHome)!
    writeCodexTrustGrantLedgerHome(managedHome, {
      ...ledger,
      binary: { kind: 'native', path: '/definitely/not/current/codex', size: 1, mtimeMs: 1 }
    })

    expect(service.getStatus()).toMatchObject({
      state: 'partial',
      detail: expect.stringContaining('Trust entry missing or stale')
    })
  })

  it('upgrades self-computed trust in place without duplicate logical entries', () => {
    prepareSystemHome()
    const service = new CodexHookService()
    process.env.ORCA_DISABLE_CODEX_TRUST_RPC = '1'
    expect(service.install().state).toBe('installed')
    const managedHome = join(userDataDir, 'codex-runtime-home', 'home')
    delete process.env.ORCA_DISABLE_CODEX_TRUST_RPC
    installCodexLikeGrantRunner()

    expect(service.install().state).toBe('installed')
    const upgraded = readFileSync(join(managedHome, 'config.toml'), 'utf-8')
    // Why: the legacy Windows fallback intentionally writes slash variants;
    // duplicate detection is about the normalized trust identity.
    const upgradedEntries = readHookTrustEntries(join(managedHome, 'config.toml'))
    for (const eventLabel of [
      'session_start',
      'user_prompt_submit',
      'pre_tool_use',
      'permission_request',
      'post_tool_use',
      'stop'
    ]) {
      const count = [...upgradedEntries.keys()].filter((key) =>
        key.endsWith(`:${eventLabel}:0:0`)
      ).length
      expect(count, `duplicate trust entries for ${eventLabel}`).toBe(1)
    }
    expect(upgraded).toContain('sha256:codex-session_start')
  })

  it('leaves user trust byte-untouched while granting managed entries', () => {
    prepareSystemHome()
    const managedHome = join(userDataDir, 'codex-runtime-home', 'home')
    mkdirSync(managedHome, { recursive: true })
    const userBlock = [
      '[hooks.state."/home/user/.codex/hooks.json:stop:3:1"]',
      'enabled = false',
      'trusted_hash = "sha256:user-owned-hash"'
    ].join('\n')
    writeFileSync(join(managedHome, 'config.toml'), `${userBlock}\n`)
    installCodexLikeGrantRunner()

    expect(new CodexHookService().install().state).toBe('installed')
    expect(readFileSync(join(managedHome, 'config.toml'), 'utf-8')).toContain(userBlock)
  })

  it('keeps the forced fallback on self-computed writes', () => {
    prepareSystemHome()
    process.env.ORCA_DISABLE_CODEX_TRUST_RPC = '1'
    const runner = vi.fn()
    trustGrantInternals.setGrantSessionRunnerSync(runner)

    const service = new CodexHookService()
    expect(service.install().state).toBe('installed')
    expect(service.getStatus().state).toBe('installed')
    expect(runner).not.toHaveBeenCalled()
    expect(resolveCodexCommandMock).not.toHaveBeenCalled()
  })

  it('restores exact config bytes before fallback after a mutating RPC failure', () => {
    prepareSystemHome()
    const service = new CodexHookService()
    process.env.ORCA_DISABLE_CODEX_TRUST_RPC = '1'
    expect(service.install().state).toBe('installed')
    const managedHome = join(userDataDir, 'codex-runtime-home', 'home')
    const baseline = readFileSync(join(managedHome, 'config.toml'))

    delete process.env.ORCA_DISABLE_CODEX_TRUST_RPC
    rmSync(managedHome, { recursive: true, force: true })
    trustGrantInternals.resetDiagnostics()
    const runner = vi.fn((request: CodexHookTrustGrantRequest) => {
      const codexHome = request.invocation.env?.CODEX_HOME
      writeFileSync(
        join(codexHome!, 'config.toml'),
        '[hooks.state."rpc-partial"]\ntrusted_hash = "sha256:changed"\n'
      )
      throw new Error('transport failed after config/batchWrite')
    })
    trustGrantInternals.setGrantSessionRunnerSync(runner)

    expect(service.install().state).toBe('installed')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(managedHome, 'config.toml'))).toEqual(baseline)
  })
})
