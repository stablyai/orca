import * as permissionLift from '../../shared/tui-agent-permission-lift'
import * as terminalPreparation from './loading-store/prepare-loaded-terminal-settings'
import * as domainWrites from './profile-state/profile-state-domain-writes'
import * as permissionArgs from '../../shared/agent-permission-args'
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
            agentArgs: '--dangerously-skip-permissions --verbose',
            launchPreferences: { agentId: 'claude', model: 'sonnet', options: { effort: 'high' } }
          },
          resolveComments: { agentId: 'codex', agentArgs: literal },
          resolveConflicts: { agentId: 'gemini', agentArgs: '--yolo' },
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
                ? '--dangerously-skip-permissions'
                : '--dangerously-bypass-approvals-and-sandbox'
              ).padEnd(64)
            },
            resolveComments: { agentArgs: ' --dangerously-bypass-approvals-and-sandbox ' },
            fixPushFailure: { agentId: null, agentArgs: literal }
          }
        }
      }))
      const lift = vi.spyOn(permissionLift, 'liftAgentPermissionArgs')
      const cut = vi.spyOn(permissionArgs, 'permissionRecipeCut')
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
      expect(lift).toHaveBeenCalledTimes(n + 4)
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
        launchPreferences: {
          agentId: 'claude',
          model: 'sonnet',
          options: { effort: 'high' },
          permissionMode: 'full-access'
        }
      })
      store.flush()
      await closeTestStores()
      marks.mockClear()
      const reopened = createStore()
      expect(marks).not.toHaveBeenCalled()
      for (const row of reopened.getRepos()) {
        expect(row.sourceControlAi?.actionOverrides?.fixChecks).toMatchObject({
          agentArgs: '',
          launchPreferences: {
            agentId: row.sourceControlAi?.actionOverrides?.fixChecks?.agentId,
            permissionMode: 'full-access'
          }
        })
      }
      const write = vi.spyOn(domainWrites, 'writeProfileStateDomains')
      const actions = reopened.getSettings().sourceControlAi?.actions
      expect(actions?.fixChecks?.launchPreferences?.permissionMode).toBe('full-access')
      expect(actions?.resolveConflicts).toMatchObject({
        agentArgs: '',
        launchPreferences: { agentId: 'gemini', permissionMode: 'full-access' }
      })
      expect(actions?.resolveComments?.agentArgs).toBe(literal)
      expect(actions?.fixPushFailure?.agentArgs).toBe(' --dangerously-skip-permissions ')
      expect(actions?.fixCommitFailure).toEqual(conflict)
      expect(actions?.commitMessage?.agentArgs).toBe('--dangerously-skip-permissions')
      const rows = reopened.getRepos()[0]?.sourceControlAi?.actionOverrides
      expect(rows?.resolveComments).toEqual(
        settled.repos[0]?.sourceControlAi?.actionOverrides?.resolveComments
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
