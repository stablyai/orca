import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

/**
 * `refreshCodexRuntimeUserHooksExclusively` maintains Orca's own profile-local managed Codex home.
 * It used to also run the legacy sweep, which mutates the user's REAL `~/.codex/config.toml` — so
 * an ordinary pane launch rewrote a file outside Orca's control. Explicit removal still sweeps.
 *
 * The assertion is at the call boundary, not on the filesystem: it proves the refresh no longer
 * reaches the sweep, not independently that the sweep is the only thing that writes ~/.codex.
 */
const { cleanupLegacyMock, readHooksJsonMock, hookPlanMock, systemHomeMock } = vi.hoisted(() => ({
  cleanupLegacyMock: vi.fn(async () => undefined),
  readHooksJsonMock: vi.fn(),
  hookPlanMock: vi.fn(),
  systemHomeMock: vi.fn(() => '/home/tester/.codex')
}))

vi.mock('./codex-hook-legacy-cleanup', () => ({
  cleanupLegacyManagedHookRepresentations: cleanupLegacyMock
}))
vi.mock('../agent-hooks/installer-utils', () => ({
  createManagedCommandMatcher: vi.fn(() => () => false),
  readHooksJson: readHooksJsonMock,
  removeManagedCommands: vi.fn((definitions: unknown[]) => definitions)
}))
vi.mock('./codex-hook-user-mirroring', () => ({
  applyMirroredRuntimeUserHookTrustStates: vi.fn(),
  getRuntimeHooksWithSystemUserHooks: hookPlanMock
}))
vi.mock('./codex-hook-definition', () => ({
  getCodexConfigTomlPath: (home: string) => `${home}/config.toml`,
  getConfigPath: (home?: string) => `${home ?? '/home/tester/.codex'}/hooks.json`,
  writeCodexHooksJson: vi.fn()
}))
vi.mock('./codex-config-mirror', () => ({ syncSystemConfigIntoManagedCodexHome: vi.fn() }))
vi.mock('./config-toml-trust', () => ({ upsertHookTrustEntries: vi.fn() }))
vi.mock('./codex-hook-identity', () => ({ getCodexManagedScriptFileName: () => 'orca-hook.sh' }))
vi.mock('./codex-hook-trust-cleanup', () => ({
  removeRuntimeManagedHookTrustEntries: vi.fn(),
  removeStaleRuntimeHookTrustEntries: vi.fn()
}))
vi.mock('./codex-home-paths', () => ({ getSystemCodexHomePath: systemHomeMock }))
vi.mock('./hook-trust-promotion', () => ({
  promoteCodexRuntimeHookApprovalsToSystem: vi.fn(),
  snapshotCodexRuntimeHookTrustProvenance: vi.fn()
}))
vi.mock('node:fs', () => ({ existsSync: () => false }))

import {
  refreshCodexRuntimeUserHooksExclusively,
  removeCodexHooksExclusively
} from './codex-hook-local-maintenance'

const STATUS: AgentHookInstallStatus = {
  agent: 'codex',
  state: 'installed',
  configPath: '/orca/managed/.codex/hooks.json',
  managedHooksPresent: true,
  detail: null
}

beforeEach(() => {
  cleanupLegacyMock.mockClear()
  readHooksJsonMock.mockReturnValue({ hooks: {} })
  hookPlanMock.mockReturnValue({ hooks: {}, trustEntries: [] })
})

describe('refreshCodexRuntimeUserHooksExclusively', () => {
  it('never sweeps the real ~/.codex on an ordinary managed-home refresh', async () => {
    await refreshCodexRuntimeUserHooksExclusively('/orca/managed/.codex', () => STATUS)

    expect(cleanupLegacyMock).not.toHaveBeenCalled()
  })

  it('never sweeps it when the managed hooks.json is unparseable either', async () => {
    readHooksJsonMock.mockReturnValue(null)

    const status = await refreshCodexRuntimeUserHooksExclusively(
      '/orca/managed/.codex',
      () => STATUS
    )

    expect(status.state).toBe('error')
    expect(cleanupLegacyMock).not.toHaveBeenCalled()
  })
})

describe('removeCodexHooksExclusively', () => {
  it('still sweeps, because opt-out convergence is a deliberate user action', async () => {
    await removeCodexHooksExclusively(() => STATUS)

    expect(cleanupLegacyMock).toHaveBeenCalledTimes(1)
  })

  it('still sweeps when the hooks.json is unparseable', async () => {
    readHooksJsonMock.mockReturnValue(null)

    await removeCodexHooksExclusively(() => STATUS)

    expect(cleanupLegacyMock).toHaveBeenCalledTimes(1)
  })
})
