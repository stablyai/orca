import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import {
  getCodexExplicitHomeHookSourcePath,
  normalizeCodexHookSourcePath
} from './config-toml-trust'
import { _internals as grantInternals } from './codex-hook-trust-grant'
import { _internals as lookupInternals } from './codex-hook-hash-lookup'
import { computeOrcaCodexHookHashes } from './codex-hook-definition'
import type { CodexHookAnswer } from './codex-hook-trust-derivation'
import { CODEX_VERSION_FOR_TESTS } from './codex-hook-trust-derivation.test-fixture'

// Why (#16441): the grant session now runs in-process instead of in a
// forked bundle that never existed under vitest. Without this stub these
// suites spawn the developer's real `codex app-server`, so they pass in CI
// (no codex installed) and fail on any machine that has one. Stand in for the
// missing binary so the fallback lane is exercised either way.
function stubMissingCodexBinary(): never {
  throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
}

export type CodexHookHomes = {
  tmpHome: string
  userDataDir: string
}

/** The answer a real Codex gives about Orca's entry. */
export function codexHookAnswerForTests(): CodexHookAnswer {
  return {
    kind: 'hashes',
    codexVersion: CODEX_VERSION_FOR_TESTS,
    hashes: computeOrcaCodexHookHashes()
  }
}

/** Applies the stubs above; for suites that build their own temp homes. */
export function stubCodexTrustSessionsForTests(): void {
  grantInternals.setGrantSessionRunner(stubMissingCodexBinary)
}

export function restoreCodexTrustSessionsForTests(): void {
  grantInternals.setGrantSessionRunner(null)
  grantInternals.resetDiagnostics()
  lookupInternals.resetForTesting()
}

export function setupCodexHookHomes(
  homedirMock: Mock<() => string>,
  getPathMock: Mock<(name: string) => string>
): CodexHookHomes {
  const homes: CodexHookHomes = { tmpHome: '', userDataDir: '' }
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    homes.tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-home-'))
    homes.userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-user-data-'))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = homes.userDataDir
    homedirMock.mockReturnValue(homes.tmpHome)
    stubCodexTrustSessionsForTests()
    getPathMock.mockImplementation((name: string) => {
      if (name === 'userData') {
        return homes.userDataDir
      }
      throw new Error(`unexpected app.getPath(${name})`)
    })
  })

  afterEach(() => {
    restoreCodexTrustSessionsForTests()
    rmSync(homes.tmpHome, { recursive: true, force: true })
    rmSync(homes.userDataDir, { recursive: true, force: true })
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    vi.clearAllMocks()
  })

  return homes
}

export function isCodexManagedCommand(command: string | undefined): boolean {
  const scriptFileName = process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
  return createManagedCommandMatcher(scriptFileName)(command)
}

export function escapeTomlBasicString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function hookTrustHeader(key: string, useDefaultCodexHome = false): string {
  const canonicalKey = canonicalizeHookTrustKeyForTest(key, useDefaultCodexHome)
  return /^[A-Za-z]:[\\/]|^\\\\/.test(canonicalKey) && !canonicalKey.includes("'")
    ? `[hooks.state.'${canonicalKey}']`
    : `[hooks.state."${escapeTomlBasicString(canonicalKey)}"]`
}

function canonicalizeHookTrustKeyForTest(key: string, useDefaultCodexHome: boolean): string {
  const lastColon = key.lastIndexOf(':')
  const secondLast = lastColon === -1 ? -1 : key.lastIndexOf(':', lastColon - 1)
  const thirdLast = secondLast === -1 ? -1 : key.lastIndexOf(':', secondLast - 1)
  if (thirdLast === -1) {
    return key
  }
  const sourcePath = key.slice(0, thirdLast)
  const trustSourcePath = useDefaultCodexHome
    ? normalizeCodexHookSourcePath(sourcePath)
    : getCodexExplicitHomeHookSourcePath(sourcePath)
  return `${trustSourcePath}${key.slice(thirdLast)}`
}
