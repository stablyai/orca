import { projectSourceControlActionLaunch } from '../../shared/source-control-action-launch-preferences'
import { resolveSourceControlActionRecipe } from '../../shared/source-control-ai-operation-policy'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { resolveAgentLaunchCommand } from '../../shared/tui-agent-launch-command'
import { isTuiAgent } from '../../shared/tui-agent-config'
import * as reconciliation from '../../shared/agent-choice-reconciliation'
import * as terminalPreparation from './loading-store/prepare-loaded-terminal-settings'
import * as domainWrites from './profile-state/profile-state-domain-writes'
import * as choiceArgs from '../../shared/agent-choice-args'
import * as shell from '../../shared/tui-agent-startup-shell'
import { agentPermissionChoices } from '../../shared/tui-agent-permission-choice'
import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readDataFile
} from './persistence-test-harness'
// Settle unrelated migrations first; only a debounced save proves the repair marked its own state dirty.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../shared/persisted-state-types'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../ssh/config/ssh-config-parser', () => ({
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
    isEncryptionAvailable: () => false
  }
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

async function settledProfile(): Promise<PersistedState> {
  writeDataFile({
    schemaVersion: 1,
    repos: [],
    worktreeMeta: {},
    settings: {},
    ui: {},
    githubCache: { pr: {}, issue: {} },
    workspaceSession: {}
  })
  const store = await createStore()
  store.flush()
  return readDataFile() as PersistedState
}

async function reloadAndSettleWrites(): Promise<PersistedState> {
  vi.useFakeTimers()
  try {
    const store = await createStore()
    vi.advanceTimersByTime(5000)
    await store.waitForPendingWrite()
  } finally {
    vi.useRealTimers()
  }
  return readDataFile() as PersistedState
}

describe('load-time normalization durability', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    vi.restoreAllMocks()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each(['claude', 'codex'] as const)(
    'retains independent %s effort when lifting a model through load, save and reopen',
    async (agent) => {
      const settled = await settledProfile()
      await closeTestStores()
      const source = settled.settings.sourceControlAi
      if (!source) {
        throw new Error('Missing settled Source Control settings')
      }
      const model = agent === 'claude' ? 'opus' : 'gpt-5.4'
      const rawModel = `--model ${model}`
      const rawEffort = agent === 'claude' ? '--effort low' : '-c model_reasoning_effort=low'
      const choices = { agentId: agent, options: { effort: 'high' } }
      settled.settings.sourceControlAi = {
        ...source,
        actions: {
          fixChecks: {
            agentId: agent,
            agentArgs: `${rawModel} ${rawEffort}`,
            launchPreferences: choices
          }
        }
      }
      settled.repos = [
        {
          id: 'independent-effort',
          displayName: 'recipe',
          badgeColor: '',
          addedAt: 0,
          path: '/tmp/recipe',
          sourceControlAi: {
            actionOverrides: {
              fixChecks: { agentId: agent, agentArgs: rawModel, launchPreferences: choices }
            }
          }
        }
      ]
      writeDataFile(settled)
      const expected = {
        agentId: agent,
        modelSelection: { base: 'default', options: { effort: { agentId: agent, value: 'high' } } }
      }
      const assertChoices = (store: ReturnType<typeof createStore>) => {
        expect(store.getSettings().sourceControlAi?.actions?.fixChecks).toMatchObject({
          agentArgs: rawEffort,
          launchPreferences: expected,
          argumentChoices: { syntaxAgent: agent, nodes: [{ at: 0, text: rawModel }] }
        })
        expect(store.getRepos()[0]?.sourceControlAi?.actionOverrides?.fixChecks).toMatchObject({
          agentArgs: '',
          launchPreferences: expected,
          argumentChoices: { syntaxAgent: agent, nodes: [{ at: 0, text: rawModel }] }
        })
      }
      const store = createStore()
      assertChoices(store)
      store.flush()
      await closeTestStores()
      const persisted = readDataFile()
      const reopened = createStore()
      assertChoices(reopened)
      reopened.flush()
      expect(readDataFile()).toEqual(persisted)
    }
  )

  const loadWork: number[][] = []
  it.each([32, 320])(
    'migrates %i owned rows through actual typed-profile load, flush and no-op reopen',
    async (n) => {
      const settled = await settledProfile()
      await closeTestStores()
      const literal = '  --yolo  --search '
      const conflict = {
        agentId: 'claude',
        agentArgs: ' --dangerously-skip-permissions ',
        launchPreferences: { agentId: 'claude', permissionMode: 'ask' }
      } as const
      settled.settings.agentPermissionDefault = 'own'
      const source = settled.settings.sourceControlAi
      if (!source) {
        throw new Error('Missing settled Source Control settings')
      }
      settled.settings.sourceControlAi = {
        ...source,
        actions: {
          fixChecks: {
            agentId: 'claude',
            agentArgs:
              '--model retired-unlisted-id --effort high --dangerously-skip-permissions --verbose'
          },
          resolveComments: { agentId: 'codex', agentArgs: literal },
          resolveConflicts: {
            agentId: 'claude',
            agentArgs: '--effort high',
            launchPreferences: {
              agentId: 'codex',
              permissionMode: 'ask',
              modelSelection: { base: 'inherit', model: { agentId: 'claude', value: null } }
            }
          },
          fixPushFailure: { agentArgs: ' --dangerously-skip-permissions ' },
          fixCommitFailure: conflict,
          commitMessage: { agentId: 'claude', agentArgs: '--dangerously-skip-permissions' }
        }
      }
      settled.repos = Array.from({ length: n }, (_, i) => ({
        id: `recipe-${i}`,
        displayName: 'recipe',
        badgeColor: '',
        addedAt: 0,
        path: '/tmp/recipe',
        sourceControlAi: {
          actionOverrides: {
            fixChecks: {
              agentId: i % 2 ? 'claude' : 'codex',
              agentArgs: (i % 2
                ? '--model retired-unlisted-id --effort high --dangerously-skip-permissions'
                : '-c model=retired-unlisted-id -c model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox'
              ).padEnd(64)
            },
            resolveComments: { agentArgs: ' --model untouched --effort high ' },
            resolveConflicts: { agentId: 'custom', agentArgs: ' --model untouched --effort high ' },
            fixPushFailure: { agentId: null, agentArgs: literal }
          }
        }
      }))
      const lift = vi.spyOn(reconciliation, 'reconcileAgentChoiceArgsDetailed')
      const cut = vi.spyOn(choiceArgs, 'analyzeAgentChoiceArgs')
      const tokenize = vi.spyOn(shell, 'tokenizeStartupCommand')
      const prepare = terminalPreparation.prepareLoadedTerminalSettings
      const marks = vi.fn()
      vi.spyOn(terminalPreparation, 'prepareLoadedTerminalSettings').mockImplementation(
        (parsed, mark) =>
          prepare(parsed, () => {
            marks()
            mark()
          })
      )
      writeDataFile(settled)
      const store = createStore()
      // Four global raw recipes plus validation of their six newly canonical terms.
      expect(lift).toHaveBeenCalledTimes(n + 10)
      const work = [
        cut.mock.calls.length,
        tokenize.mock.calls.length,
        tokenize.mock.calls.reduce((sum, [text]) => sum + text.length, 0)
      ]
      const choices = Math.max(
        ...(['claude', 'codex'] as const).map((agent) => agentPermissionChoices(agent).length - 1)
      )
      expect(work[0]).toBeGreaterThanOrEqual(n)
      // Per choice: recipe + choice inventory + three original/cut shell grammars.
      expect(work[1]).toBeLessThanOrEqual((n + 4) * choices * (1 + choices + 6))
      if (n === 320) {
        work.forEach((count, index) => expect(count).toBeLessThanOrEqual(10 * loadWork[0][index]))
      }
      loadWork.push(work)
      process.stdout.write(
        `${JSON.stringify({
          metric: 'permission-load-work',
          rows: n,
          lifts: lift.mock.calls.length,
          cuts: work[0],
          tokens: work[1],
          chars: work[2]
        })}\n`
      )

      expect(store.getSettings().sourceControlAi?.actions?.fixChecks).toMatchObject({
        agentArgs: '--verbose',
        argumentChoices: {
          syntaxAgent: 'claude',
          nodes: [
            { at: 0, text: '--model retired-unlisted-id' },
            { at: 0, text: '--effort high' }
          ]
        },
        launchPreferences: {
          agentId: 'claude',
          permissionMode: 'full-access'
        }
      })
      if (n === 32) {
        const failure = vi
          .spyOn(domainWrites, 'writeProfileStateDomains')
          .mockImplementationOnce(() => {
            throw new Error('disk refused')
          })
        expect(() => store.flushOrThrow()).toThrow('disk refused')
        expect(readDataFile()).toEqual(settled)
        failure.mockRestore()
      }
      store.flush()
      await closeTestStores()
      marks.mockClear()
      const reopened = createStore()
      expect(marks).not.toHaveBeenCalled()
      for (const row of reopened.getRepos()) {
        expect(row.sourceControlAi?.actionOverrides?.fixChecks).toMatchObject({
          agentArgs: '',
          argumentChoices: {
            syntaxAgent: row.sourceControlAi?.actionOverrides?.fixChecks?.agentId,
            nodes: [
              {
                at: 0,
                text:
                  row.sourceControlAi?.actionOverrides?.fixChecks?.agentId === 'claude'
                    ? '--model retired-unlisted-id'
                    : '-c model=retired-unlisted-id'
              },
              {
                at: 0,
                text:
                  row.sourceControlAi?.actionOverrides?.fixChecks?.agentId === 'claude'
                    ? '--effort high'
                    : '-c model_reasoning_effort=high'
              }
            ]
          },
          launchPreferences: {
            agentId: row.sourceControlAi?.actionOverrides?.fixChecks?.agentId,
            permissionMode: 'full-access'
          }
        })
      }
      for (const row of reopened.getRepos().slice(0, 2)) {
        const recipe = resolveSourceControlActionRecipe({
          settings: reopened.getSettings(),
          repo: row,
          actionId: 'fixChecks'
        })
        if (!isTuiAgent(recipe.agentId)) {
          throw new Error('Missing concrete migrated agent')
        }
        const projection = projectSourceControlActionLaunch(recipe, recipe.agentId, {
          basePrompt: 'Fix checks'
        })
        const launch = resolveAgentLaunchCommand({
          ...resolveAgentStartupPlanInputs({
            agent: recipe.agentId,
            settings: reopened.getSettings(),
            platform: 'linux',
            isRemote: false,
            shell: 'posix',
            agentArgs: projection.agentArgs,
            sessionOptions: projection.sessionOptions
          }),
          shell: 'posix'
        })
        expect(launch.ok).toBe(true)
        if (!launch.ok) {
          throw new Error(launch.error)
        }
        expect(launch.appliedSessionOptions).toEqual({
          model: 'retired-unlisted-id',
          effort: 'high',
          permissionMode: 'full-access'
        })
        expect(launch.command).toBe(
          recipe.agentId === 'claude'
            ? "claude '--model' 'retired-unlisted-id' '--effort' 'high' '--dangerously-skip-permissions'"
            : "codex '-c' 'disable_paste_burst=true' '-m' 'retired-unlisted-id' '-c' 'model_reasoning_effort=high' '--dangerously-bypass-approvals-and-sandbox'"
        )
      }
      const write = vi.spyOn(domainWrites, 'writeProfileStateDomains')
      const actions = reopened.getSettings().sourceControlAi?.actions
      expect(actions?.fixChecks?.launchPreferences?.permissionMode).toBe('full-access')
      expect(actions?.resolveConflicts).toMatchObject({
        agentArgs: '',
        launchPreferences: {
          agentId: 'codex',
          permissionMode: 'ask',
          modelSelection: {
            base: 'inherit',
            model: { agentId: 'claude', value: null }
          }
        },
        argumentChoices: { syntaxAgent: 'claude', nodes: [{ at: 0, text: '--effort high' }] }
      })
      expect(actions?.resolveComments?.agentArgs).toBe(literal)
      expect(actions?.fixPushFailure?.agentArgs).toBe(' --dangerously-skip-permissions ')
      expect(actions?.fixCommitFailure).toEqual(conflict)
      expect(actions?.commitMessage?.agentArgs).toBe('--dangerously-skip-permissions')
      const rows = reopened.getRepos()[0]?.sourceControlAi?.actionOverrides
      expect(rows?.resolveComments).toEqual(
        settled.repos[0]?.sourceControlAi?.actionOverrides?.resolveComments
      )
      expect(rows?.resolveConflicts).toEqual(
        settled.repos[0]?.sourceControlAi?.actionOverrides?.resolveConflicts
      )
      expect(rows?.fixPushFailure).toEqual(
        settled.repos[0]?.sourceControlAi?.actionOverrides?.fixPushFailure
      )
      const stable = readDataFile()
      reopened.flush()
      expect(readDataFile()).toEqual(stable)
      expect(write).toHaveReturnedWith({
        changed: false,
        revision: expect.any(Number),
        changedDomains: []
      })
      write.mockClear()
      reopened.flush()
      expect(write).not.toHaveBeenCalled()
    }
  )

  it('durably demotes a well-shaped current term whose effort is no longer supported', async () => {
    const settled = await settledProfile()
    await closeTestStores()
    settled.settings.sourceControlAi!.actions!.fixChecks = {
      agentId: 'codex',
      agentArgs: '--search',
      argumentChoices: {
        syntaxAgent: 'codex',
        nodes: [{ at: 0, text: '-c model_reasoning_effort=retired' }]
      }
    }
    settled.repos = [
      {
        id: 'retired-effort',
        displayName: 'recipe',
        badgeColor: '',
        addedAt: 0,
        path: '/tmp/recipe',
        sourceControlAi: {
          actionOverrides: { fixChecks: settled.settings.sourceControlAi!.actions!.fixChecks }
        }
      }
    ]
    const mark = vi.fn()
    terminalPreparation.prepareLoadedTerminalSettings(settled, mark)
    expect(mark).toHaveBeenCalled()
    writeDataFile(settled)
    const persisted = await reloadAndSettleWrites()
    expect(persisted.settings.sourceControlAi?.actions?.fixChecks).toMatchObject({
      agentArgs: ' -c model_reasoning_effort=retired --search'
    })
    expect(persisted.settings.sourceControlAi?.actions?.fixChecks?.argumentChoices).toBeUndefined()
    expect(persisted.repos[0].sourceControlAi?.actionOverrides?.fixChecks).toEqual(
      persisted.settings.sourceControlAi?.actions?.fixChecks
    )
    await closeTestStores()
    expect(createStore().getSettings().sourceControlAi?.actions?.fixChecks).toEqual(
      persisted.settings.sourceControlAi?.actions?.fixChecks
    )
  })

  it.each(['document', 'selection'] as const)(
    'rejects malformed %s writes and preserves stored data at the load error owner',
    async (kind) => {
      const settled = await settledProfile()
      const invalid =
        kind === 'document'
          ? {
              agentId: 'claude' as const,
              agentArgs: '',
              argumentChoices: {
                syntaxAgent: 'claude' as const,
                nodes: [{ at: 99, text: '--model opus' }]
              }
            }
          : {
              agentId: 'claude' as const,
              launchPreferences: {
                agentId: 'claude' as const,
                modelSelection: {
                  base: 'inherit' as const,
                  model: { agentId: 'claude' as const, value: 'x'.repeat(513) }
                }
              }
            }
      const store = createStore()
      const source = store.getSettings().sourceControlAi!
      expect(() =>
        store.updateSettings({ sourceControlAi: { ...source, actions: { fixChecks: invalid } } })
      ).toThrow(
        kind === 'document'
          ? 'Invalid action argument choice position'
          : 'Invalid action model choice'
      )
      expect(store.getSettings().sourceControlAi).toEqual(source)
      await closeTestStores()
      settled.settings.sourceControlAi = { ...source, actions: { fixChecks: invalid } }
      writeDataFile(settled)
      const raw = readDataFile()
      expect(() => createStore()).toThrow('Failed to load imported profile state')
      expect(readDataFile()).toEqual(raw)
    }
  )

  it('persists the legacy search-tab explorer view repair', async () => {
    const settled = await settledProfile()
    delete (settled.ui as Record<string, unknown>).rightSidebarExplorerView
    settled.ui.rightSidebarTab = 'search'
    writeDataFile(settled)

    const persisted = await reloadAndSettleWrites()

    expect(persisted.ui.rightSidebarExplorerView).toBe('search')
  })

  it('persists a repaired notification settings block', async () => {
    const settled = await settledProfile()
    settled.settings.notifications = {
      ...settled.settings.notifications,
      enabled: 'false' as unknown as boolean
    }
    writeDataFile(settled)

    const persisted = await reloadAndSettleWrites()

    expect(persisted.settings.notifications.enabled).toBe(true)
  })
})
