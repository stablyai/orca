import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { ExternalWorktreeVisibility } from '../shared/repo-types'
import { getDefaultPersistedState } from '../shared/constants'
import { testState, createStore, writeDataFile, makeRepo } from './persistence-test-harness'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })
  it('updateRepo stamps legacy external-worktree visibility before changing old repos', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        addedAt: Date.UTC(2026, 4, 24),
        externalWorktreeVisibility: undefined,
        externalWorktreeVisibilityLegacy: undefined
      })
    )

    const updated = store.updateRepo('r1', { externalWorktreeVisibility: 'hide' })

    expect(updated!.externalWorktreeVisibility).toBe('hide')
    expect(updated!.externalWorktreeVisibilityLegacy).toBe(true)
  })

  it('migrates implicit legacy visibility to an explicit override before defaulting global hide', async () => {
    const persisted = getDefaultPersistedState(testState.dir)
    delete persisted.settings.worktreeVisibilityDefaults
    persisted.repos = [
      makeRepo({
        id: 'legacy',
        kind: 'git',
        externalWorktreeVisibility: undefined,
        externalWorktreeVisibilityLegacy: undefined
      }),
      makeRepo({ id: 'explicit', externalWorktreeVisibility: 'hide' }),
      makeRepo({
        id: 'inherited',
        externalWorktreeVisibility: undefined,
        externalWorktreeVisibilityLegacy: false
      })
    ]
    writeDataFile(persisted)

    const store = await createStore()

    expect(store.getSettings().worktreeVisibilityDefaults).toEqual({ external: 'hide' })
    expect(store.getRepo('legacy')).toMatchObject({
      externalWorktreeVisibility: 'show',
      externalWorktreeVisibilityLegacy: true
    })
    expect(store.getRepo('explicit')?.externalWorktreeVisibility).toBe('hide')
    expect(store.getRepo('inherited')?.externalWorktreeVisibility).toBeUndefined()

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('legacy')).toMatchObject({
      externalWorktreeVisibility: 'show',
      externalWorktreeVisibilityLegacy: true
    })
    expect(reloaded.getRepo('inherited')?.externalWorktreeVisibility).toBeUndefined()
  })

  it('merges visibility-default patches so future source defaults survive older controls', async () => {
    const store = await createStore()
    store.updateSettings({
      worktreeVisibilityDefaults: {
        external: 'show',
        futureSource: 'hide'
      } as GlobalSettings['worktreeVisibilityDefaults']
    })

    store.updateSettings({ worktreeVisibilityDefaults: { external: 'hide' } })

    expect(store.getSettings().worktreeVisibilityDefaults).toEqual({
      external: 'hide',
      futureSource: 'hide'
    })
  })

  it('normalizes and persists global worktree source defaults', async () => {
    const store = await createStore()

    store.updateSettings({
      worktreeVisibilityDefaults: {
        external: 'show',
        customSources: [
          { id: 'team', rootPath: ' /srv/team-worktrees ' },
          { id: 'invalid', rootPath: '../relative' }
        ],
        sourcePreferences: {
          builtIn: { claude: 'show', gsd: 'hide' },
          custom: { team: 'show' }
        }
      }
    })

    expect(store.getSettings().worktreeVisibilityDefaults).toEqual({
      external: 'show',
      customSources: [{ id: 'team', rootPath: '/srv/team-worktrees' }],
      sourcePreferences: {
        builtIn: { claude: 'show', gsd: 'hide' },
        custom: { team: 'show' }
      }
    })
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getSettings().worktreeVisibilityDefaults).toEqual(
      store.getSettings().worktreeVisibilityDefaults
    )
  })

  it('persists agent worktree visibility independently from external visibility', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ externalWorktreeVisibility: 'hide' }))

    const updated = store.updateRepo('r1', { agentWorktreeVisibility: 'show' })

    expect(updated).toMatchObject({
      externalWorktreeVisibility: 'hide',
      agentWorktreeVisibility: 'show',
      worktreeVisibilitySourcePreferences: {
        builtIn: { claude: 'show', gsd: 'show' }
      }
    })

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')).toMatchObject({
      externalWorktreeVisibility: 'hide',
      agentWorktreeVisibility: 'show',
      worktreeVisibilitySourcePreferences: {
        builtIn: { claude: 'show', gsd: 'show' }
      }
    })
  })

  it('persists bounded custom worktree sources separately from their preferences', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', {
      customWorktreeVisibilitySources: [
        { id: 'team', rootPath: ' /srv/team-worktrees ' },
        { id: 'invalid', rootPath: '../relative' }
      ],
      worktreeVisibilitySourcePreferences: {
        builtIn: { claude: 'show', gsd: 'hide' },
        custom: { team: 'show' }
      }
    })

    expect(updated).toMatchObject({
      customWorktreeVisibilitySources: [{ id: 'team', rootPath: '/srv/team-worktrees' }],
      worktreeVisibilitySourcePreferences: {
        builtIn: { claude: 'show', gsd: 'hide' },
        custom: { team: 'show' }
      }
    })

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')?.customWorktreeVisibilitySources).toEqual([
      { id: 'team', rootPath: '/srv/team-worktrees' }
    ])
  })

  it('clears an explicit external-worktree override without stamping an inherited default', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        externalWorktreeVisibility: 'show',
        externalWorktreeVisibilityLegacy: true
      })
    )

    const updated = store.updateRepo('r1', { externalWorktreeVisibility: null })

    expect(updated?.externalWorktreeVisibility).toBeUndefined()
    expect(updated?.externalWorktreeVisibilityLegacy).toBe(false)
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')?.externalWorktreeVisibility).toBeUndefined()
    expect(reloaded.getRepo('r1')?.externalWorktreeVisibilityLegacy).toBe(false)
  })

  it('sanitizes raw custom worktree visibility sources on the read path', async () => {
    const persisted = getDefaultPersistedState(testState.dir)
    persisted.repos = [
      makeRepo({
        id: 'r1',
        customWorktreeVisibilitySources: [
          { id: 'team', rootPath: ' /srv/team-worktrees ' },
          { id: 'invalid', rootPath: '../relative' }
        ],
        worktreeVisibilitySourcePreferences: {
          builtIn: { claude: 'show', gsd: 'show' },
          custom: { team: 'show', missing: 'bogus' as unknown as ExternalWorktreeVisibility }
        }
      })
    ]
    writeDataFile(persisted)

    const store = await createStore()
    expect(store.getRepo('r1')).toMatchObject({
      customWorktreeVisibilitySources: [{ id: 'team', rootPath: '/srv/team-worktrees' }],
      worktreeVisibilitySourcePreferences: {
        builtIn: { claude: 'show', gsd: 'show' },
        custom: { team: 'show' }
      }
    })
  })

  it('updateRepo clears source-control AI overrides independently from other clearable fields', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        issueSourcePreference: 'origin',
        sourceControlAi: {
          instructionsByOperation: { commitMessage: 'Repo style' },
          prCreationDefaults: { draft: true }
        }
      })
    )

    store.updateRepo('r1', {
      issueSourcePreference: undefined,
      sourceControlAi: undefined
    })

    expect(store.getRepo('r1')!.issueSourcePreference).toBeUndefined()
    expect(store.getRepo('r1')!.sourceControlAi).toBeUndefined()

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.issueSourcePreference).toBeUndefined()
    expect(reloaded.getRepo('r1')!.sourceControlAi).toBeUndefined()
  })

  it('updateRepo treats source-control AI null as a transport clear sentinel', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        sourceControlAi: {
          enabled: true,
          customAgentCommand: 'repo-agent {prompt}'
        }
      })
    )

    store.updateRepo('r1', {
      sourceControlAi: null
    })

    expect(store.getRepo('r1')!.sourceControlAi).toBeUndefined()

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.sourceControlAi).toBeUndefined()
  })

  it('updateRepo normalizes source-control AI overrides before storing', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', {
      sourceControlAi: {
        instructionsByOperation: {
          commitMessage: 'Repo style',
          pullRequest: 42,
          unknown: 'ignored'
        },
        prCreationDefaults: {
          draft: true,
          useTemplate: null,
          openAfterCreate: 'yes'
        },
        modelOverridesByOperation: {
          commitMessage: {
            selectedModelByAgent: { codex: 'gpt-5.4', claude: false },
            selectedThinkingByModel: { 'gpt-5.4': 'high', bad: true }
          },
          unknown: {
            selectedModelByAgent: { codex: 'ignored' }
          }
        }
      } as never
    })

    expect(updated!.sourceControlAi).toEqual({
      instructionsByOperation: {
        commitMessage: 'Repo style'
      },
      actionOverrides: {
        commitMessage: {
          commandInputTemplate: '{basePrompt}\n\nRepo style'
        }
      },
      prCreationDefaults: {
        draft: true,
        useTemplate: null
      },
      modelOverridesByOperation: {
        commitMessage: {
          selectedModelByAgent: { codex: 'gpt-5.4' },
          selectedThinkingByModel: { 'gpt-5.4': 'high' }
        }
      }
    })
  })

  it('updateRepo ignores malformed source-control AI overrides without clearing existing overrides', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        sourceControlAi: {
          instructionsByOperation: { commitMessage: 'Keep me' }
        }
      })
    )

    const updated = store.updateRepo('r1', { sourceControlAi: 'bad' as never })

    expect(updated!.sourceControlAi).toEqual({
      instructionsByOperation: { commitMessage: 'Keep me' },
      actionOverrides: {
        commitMessage: {
          commandInputTemplate: '{basePrompt}\n\nKeep me'
        }
      }
    })
  })
})
