import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Project } from '../../shared/project-types'
import { createSettings } from '../codex-accounts/runtime-home-settings-test-fixtures'
import { assertNativeCodexAccountPlacement } from './runtime-codex-account-placement'

vi.mock('../wsl', () => ({
  getCachedWslAvailability: () => true,
  hasCachedWslAvailability: () => true,
  getCachedWslDistros: () => ['Ubuntu'],
  hasCachedWslDistros: () => true
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

const repo: Repo = {
  id: 'repo-1',
  path: 'C:\\fixture',
  displayName: 'fixture',
  badgeColor: 'blue',
  addedAt: 1
}
function fixture() {
  const settings = createSettings()
  const projects: Project[] = []
  const store = { getSettings: () => settings, getRepo: () => repo, getProjects: () => projects }
  return { args: { store, repo, cwd: repo.path }, settings, projects }
}

describe('Codex account native placement preflight', () => {
  it.each(['darwin', 'linux', 'win32'])(
    'accepts a native git or folder workspace on %s',
    (platform) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      const { args } = fixture()
      expect(() => assertNativeCodexAccountPlacement(args)).not.toThrow()
      expect(() => assertNativeCodexAccountPlacement({ ...args, repo: null })).not.toThrow()
    }
  )

  it.each(['ssh:target', 'runtime:server'] as const)(
    'rejects %s for both repositories and folder workspaces',
    (executionHostId) => {
      const { args } = fixture()
      expect(() =>
        assertNativeCodexAccountPlacement({ ...args, repo: { ...repo, executionHostId } })
      ).toThrow('native host only')
      expect(() =>
        assertNativeCodexAccountPlacement({ ...args, repo: null, executionHostId })
      ).toThrow('native host only')
    }
  )

  it('rejects SSH routing independently of repo metadata', () => {
    expect(() =>
      assertNativeCodexAccountPlacement({ ...fixture().args, connectionId: 'target' })
    ).toThrow('native host only')
  })

  it('rejects custom commands that can replace the Codex launch', () => {
    const { args, settings } = fixture()
    settings.agentCmdOverrides = { codex: 'custom-codex-wrapper' }
    expect(() => assertNativeCodexAccountPlacement(args)).toThrow('custom Codex launch command')
  })

  it('rejects a WSL cwd on every host', () => {
    expect(() =>
      assertNativeCodexAccountPlacement({
        ...fixture().args,
        cwd: '\\\\wsl$\\Ubuntu\\home\\fixture'
      })
    ).toThrow('WSL')
  })

  it('rejects Windows WSL shell choice and project placement before a checkout is created', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const { args, projects } = fixture()
    expect(() => assertNativeCodexAccountPlacement({ ...args, shellOverride: 'wsl.exe' })).toThrow(
      'WSL'
    )
    projects.push({
      id: 'project-1',
      displayName: 'fixture',
      badgeColor: 'blue',
      sourceRepoIds: [repo.id],
      createdAt: 1,
      updatedAt: 1,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })
    expect(() => assertNativeCodexAccountPlacement(args)).toThrow('WSL')
  })
})
