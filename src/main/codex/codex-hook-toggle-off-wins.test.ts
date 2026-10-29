import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as CodexCommand from '../codex-cli/command'
import type * as TrustDerivation from './codex-hook-trust-derivation'

const mocks = vi.hoisted(() => ({
  homedir: vi.fn<() => string>(),
  codexPath: '',
  probeCodexVersion: vi.fn(),
  deriveCodexHookHashes: vi.fn()
}))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: mocks.homedir
}))
vi.mock('../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCommand>()),
  resolveCodexCommand: () => mocks.codexPath
}))
vi.mock('./codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  probeCodexVersion: mocks.probeCodexVersion,
  deriveCodexHookHashes: mocks.deriveCodexHookHashes
}))

import {
  MANAGED_AGENT_HOOK_INSTALLERS,
  MANAGED_AGENT_HOOK_REMOVERS
} from '../agent-hooks/managed-agent-hook-registry'
import { _internals, startCodexHooks } from './codex-hook-reconcile'
import { _internals as lookupInternals } from './codex-hook-hash-lookup'
import { CODEX_EVENT_LABEL, getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import { readHookTrustEntries } from './config-toml-trust'

let root: string
let home: string
let enabled: boolean
let usesRealHome: boolean

const CODEX_HASHES: CodexHookHashes = Object.fromEntries(
  Object.values(CODEX_EVENT_LABEL).map((label) => [label, `sha256:codex-${label}`])
)
const installCodex = MANAGED_AGENT_HOOK_INSTALLERS.find(([agent]) => agent === 'codex')![1]
const removeCodex = MANAGED_AGENT_HOOK_REMOVERS.find(([agent]) => agent === 'codex')![1]

function expectNoOrcaHook(codexHome: string): void {
  const hooksPath = join(codexHome, 'hooks.json')
  if (existsSync(hooksPath)) {
    expect(readFileSync(hooksPath, 'utf-8')).not.toContain(
      getCodexManagedHookInstallMaterial().command
    )
  }
  expect(readHookTrustEntries(join(codexHome, 'config.toml')).size).toBe(0)
}

beforeEach(() => {
  // Resolve macOS /var symlinks to avoid a second trust-key spelling.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-codex-toggle-')))
  home = join(root, 'home')
  const userData = join(root, 'user-data')
  mkdirSync(home)
  mkdirSync(userData)
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  vi.stubEnv('CODEX_HOME', '')
  mocks.homedir.mockReturnValue(home)
  mocks.codexPath = join(userData, 'codex')
  writeFileSync(mocks.codexPath, 'codex 0.160.1')
  mocks.probeCodexVersion.mockResolvedValue('codex-cli 0.160.1')
  _internals.resetForTesting()
  lookupInternals.resetForTesting()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('turning hooks off while turning them on still waits for Codex', () => {
  it.each([
    ['~/.codex', true],
    ['a custom CODEX_HOME', false]
  ])('leaves no Orca entry or approval with %s selected', async (_name, realHome) => {
    usesRealHome = realHome
    let answer!: () => void
    mocks.deriveCodexHookHashes.mockReturnValue(
      new Promise((resolve) => {
        answer = () =>
          resolve({ kind: 'hashes', codexVersion: 'codex-cli 0.160.1', hashes: CODEX_HASHES })
      })
    )
    enabled = false
    startCodexHooks({
      isEnabled: () => enabled,
      resolveLaunchHome: () => (usesRealHome ? null : join(root, 'custom-codex-home')),
      pathReady: Promise.resolve()
    })
    await _internals.settledForTesting()

    enabled = true
    let onSettled = false
    const on = Promise.resolve(installCodex()).finally(() => {
      onSettled = true
    })
    // Turn Off during On's hash lookup, if On waits at all.
    while (!onSettled && mocks.deriveCodexHookHashes.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    enabled = false
    await removeCodex()
    answer()
    await on
    await _internals.settledForTesting()

    expectNoOrcaHook(join(home, '.codex'))
    expectNoOrcaHook(getOrcaManagedCodexHomePath())
  })
})
