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
import {
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
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
import { getCodexHookTrustSignature } from './codex-hook-identity'

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
  trustGrantInternals.setGrantSessionRunner(null)
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

// Why: the opt-out only strips files; a grant session here would mean it asked Codex to trust something.
function forbidGrantSessions(): ReturnType<typeof vi.fn> {
  const runner = vi.fn(async () => {
    throw new Error('opt-out must not run a Codex trust-grant session')
  })
  trustGrantInternals.setGrantSessionRunner(runner)
  return runner
}

function prepareSystemHome(): void {
  mkdirSync(join(tmpHome, '.codex'), { recursive: true })
}

describe('CodexHookService opt-out of the real-home entry', () => {
  it('retries ledger-proven real-home trust cleanup on opt-out after the hook is already gone', async () => {
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
    const grantSession = forbidGrantSessions()

    await new CodexHookService().remove()

    expect(grantSession).not.toHaveBeenCalled()

    expect(readHookTrustEntries(configPath).has(trustKey)).toBe(false)
    expect(readCodexTrustGrantLedgerHome(systemHome)).toBeNull()
  })

  // Why: ordinary Windows CI tokens cannot create file symlinks without Developer Mode.
  it.skipIf(process.platform === 'win32')(
    'keeps a real-home symlink and moves later user trust during an explicit opt-out',
    async () => {
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
      const grantSession = forbidGrantSessions()

      await new CodexHookService().remove()

      expect(grantSession).not.toHaveBeenCalled()

      expect(lstatSync(hooksPath).isSymbolicLink()).toBe(true)
      expect(JSON.parse(readFileSync(targetPath, 'utf-8')).hooks.Stop).toEqual([
        { hooks: [userHook] }
      ])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'preserves restrictive real-home hooks permissions during an explicit opt-out',
    async () => {
      prepareSystemHome()
      const hooksPath = join(tmpHome, '.codex', 'hooks.json')
      const material = getCodexManagedHookInstallMaterial()
      writeFileSync(
        hooksPath,
        `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: material.command }] }] } }, null, 2)}\n`
      )
      chmodSync(hooksPath, 0o600)
      const grantSession = forbidGrantSessions()

      await new CodexHookService().remove()

      expect(grantSession).not.toHaveBeenCalled()

      expect(statSync(hooksPath).mode & 0o777).toBe(0o600)
    }
  )
})
