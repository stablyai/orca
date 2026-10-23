import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as NodeOs from 'node:os'
import type * as CodexCommand from '../codex-cli/command'
import type * as TrustDerivation from '../codex/codex-hook-trust-derivation'
import type { CodexHookAnswer } from '../codex/codex-hook-trust-derivation'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createStore,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

const mocks = vi.hoisted(() => ({
  codexPath: '',
  probeCodexVersion: vi.fn<(codexPath: string) => Promise<string | null>>(),
  deriveCodexHookHashes: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => testState.fakeHomeDir
}))
vi.mock('../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCommand>()),
  resolveCodexCommand: () => mocks.codexPath
}))
vi.mock('../codex/codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  probeCodexVersion: mocks.probeCodexVersion,
  deriveCodexHookHashes: mocks.deriveCodexHookHashes
}))

// Why this file (#13746): a status-hook problem costs only Orca's status. The
// system default must keep launching on ~/.codex, so its own login is used.

const hooksPath = (): string => join(getSystemCodexHomePath(), 'hooks.json')
const tomlPath = (): string => join(getSystemCodexHomePath(), 'config.toml')

const HOOK_PROBLEMS: readonly [string, () => void][] = [
  [
    'Codex is too old to approve hooks',
    () => {
      const failure = 'Codex 0.120.0 is too old for Orca status; update Codex'
      mocks.deriveCodexHookHashes.mockResolvedValue({
        kind: 'refused',
        codexVersion: 'codex-cli 0.120.0',
        failure
      } satisfies CodexHookAnswer)
    }
  ],
  ['Codex is not installed', () => (mocks.codexPath = join(testState.fakeHomeDir, 'no-codex'))],
  ['~/.codex/hooks.json does not parse', () => writeFileSync(hooksPath(), '{ not json')],
  [
    '~/.codex/hooks.json has a root key Codex skips',
    () => writeFileSync(hooksPath(), JSON.stringify({ hooks: {}, _managed: true }))
  ],
  [
    '~/.codex/config.toml keeps hook approvals inline',
    () => writeFileSync(tomlPath(), 'model = "m"\nhooks = { state = {} }\n')
  ]
]

beforeEach(() => {
  setupRuntimeHomeTest()
  mocks.codexPath = join(testState.userDataDir, 'codex')
  writeFileSync(mocks.codexPath, 'codex')
  mocks.probeCodexVersion.mockResolvedValue('codex-cli 0.160.1')
  mocks.deriveCodexHookHashes.mockResolvedValue({
    kind: 'hashes',
    codexVersion: 'codex-cli 0.160.1',
    hashes: { stop: 'sha256:codex-stop' }
  } satisfies CodexHookAnswer)
})

afterEach(() => {
  vi.restoreAllMocks()
  teardownRuntimeHomeTest()
})

describe('a status-hook problem never moves the system default off ~/.codex', () => {
  it.each(HOOK_PROBLEMS)('when %s', async (_case, arrange) => {
    arrange()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = new Map(
      [hooksPath(), tomlPath()].map((path) => [path, readOptional(path)] as const)
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const { startCodexHooks, _internals } = await import('../codex/codex-hook-reconcile')
    const { readCurrentCodexHookStatus } = await import('../codex/codex-hook-status')
    const store = createStore(createSettings({ realHomeRoutable: true }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only getSettings/updateSettings, which the harness store implements.
    const service = new CodexRuntimeHomeService(store as never)
    // Wired as app start wires it, so the status reads the home launches get.
    startCodexHooks({
      pathReady: Promise.resolve(),
      isEnabled: () => true,
      resolveLaunchHome: () => service.resolveHostCodexHomePathForLaunchReadOnly()
    })
    await _internals.settledForTesting()

    expect(service.isHostSystemDefaultRealHomeSelected()).toBe(true)
    // The resolver headless serve and the PTY launch both use: null keeps CODEX_HOME unset.
    expect(service.resolveHostCodexHomePathForLaunchReadOnly()).toBeNull()
    await expect(service.prepareForCodexLaunchAsync()).resolves.toBeNull()
    const status = readCurrentCodexHookStatus()
    expect(status.configPath).toBe(hooksPath())
    expect(status.detail).toBeTruthy()
    if (before.get(hooksPath()) !== null) {
      expect(readOptional(hooksPath())).toBe(before.get(hooksPath()))
    }
  })
})

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}
