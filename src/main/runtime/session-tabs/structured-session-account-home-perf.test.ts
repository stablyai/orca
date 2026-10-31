import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import { ClaudeProfileRouter } from '../../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'
import { OrcaRuntimeWithStructuredSessionAccountHome } from './structured-session-account-home'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    lstatSync: vi.fn(actual.lstatSync),
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync)
  }
})
vi.mock('../../orca-profiles/profile-storage-paths', async () => {
  const { tmpdir } = await import('node:os')
  return { getProfileUserDataPath: () => tmpdir() }
})
vi.mock('./structured-session-cli-writer-host', () => ({
  OrcaRuntimeWithStructuredSessionCliWriterHost: class {}
}))

const roots: string[] = []
afterEach(() => {
  installClaudeProfileRouter(undefined)
  vi.restoreAllMocks()
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

it.each([25, 250])('bounds desired-home reads with %i managed accounts', async (accounts) => {
  for (const signedIn of [true, false]) {
    for (const deliveries of [10, 100]) {
      const root = fs.mkdtempSync(join(tmpdir(), 'orca-account-read-perf-'))
      roots.push(root)
      let accountVisits = 0
      let selectionReads = 0
      const selected = `account-${accounts - 1}`
      const managed: ClaudeManagedAccount[] = Array.from({ length: accounts }, (_, index) => ({
        get id() {
          accountVisits += 1
          return `account-${index}`
        },
        email: 'selected@example.test',
        authMethod: 'subscription-oauth',
        managedAuthPath: '/unused',
        createdAt: 0,
        updatedAt: 0,
        lastAuthenticatedAt: 0
      }))
      const settings = {
        claudeManagedAccounts: managed,
        get activeClaudeManagedAccountId() {
          selectionReads += 1
          return selected
        },
        activeClaudeManagedAccountIdsByRuntime: undefined,
        agentStatusHooksEnabled: false,
        disabledTuiAgents: []
      }
      const router = new ClaudeProfileRouter({
        getSettings: () => settings,
        dataRoot: root,
        userHome: join(root, 'personal'),
        env: { CLAUDE_CONFIG_DIR: join(root, 'system') }
      })
      const selectedHome = router.accountHome(selected)
      const systemHome = router.systemDefaultHome()
      for (const home of signedIn ? [selectedHome] : [selectedHome, systemHome]) {
        fs.mkdirSync(home, { recursive: true })
      }
      const state = JSON.stringify({
        oauthAccount: { emailAddress: 'selected@example.test' },
        projects: Object.fromEntries(
          Array.from({ length: 1_000 }, (_, index) => [
            `/workspace-${index}`,
            { hasTrustDialogAccepted: true }
          ])
        )
      })
      const stateFile = join(signedIn ? selectedHome : systemHome, '.claude.json')
      fs.writeFileSync(stateFile, state)
      installClaudeProfileRouter(router)
      // Exercise the runtime entry point without constructing services or starting an agent.
      const runtime: OrcaRuntimeWithStructuredSessionAccountHome = Object.assign(
        Object.create(OrcaRuntimeWithStructuredSessionAccountHome.prototype),
        {
          accounts: { getClaudeConfigDirectory: () => router.systemDefaultHome() },
          requireStore: () => ({ getSettings: () => settings }),
          structuredAgentLaunchEnv: () => ({})
        }
      )
      const reads = vi.spyOn(router, 'routedHome')
      for (const spy of [
        fs.statSync,
        fs.lstatSync,
        fs.existsSync,
        fs.readFileSync,
        fs.readdirSync
      ]) {
        vi.mocked(spy).mockClear()
      }
      accountVisits = 0
      selectionReads = 0
      const record = agentSessionRecordFixture()
      let answer: AgentSessionAccountHome | null = null
      const started = performance.now()
      for (let delivery = 0; delivery < deliveries; delivery += 1) {
        answer = await runtime.resolveStructuredAgentLaunchAccountHome(record)
      }
      const elapsedMs = performance.now() - started
      expect(answer).toEqual({
        variable: 'CLAUDE_CONFIG_DIR',
        path: signedIn ? selectedHome : systemHome
      })
      const stats = vi.mocked(fs.statSync).mock.calls.length
      const directoryStats = vi.mocked(fs.lstatSync).mock.calls.length
      const stateReads = vi.mocked(fs.readFileSync).mock.calls.length
      expect(reads).toHaveBeenCalledTimes(deliveries)
      expect(selectionReads).toBe(deliveries)
      expect(accountVisits).toBe(signedIn ? 0 : accounts * deliveries)
      expect(stats).toBe(signedIn ? deliveries : 2 * deliveries)
      expect(directoryStats).toBe(signedIn ? deliveries : 0)
      expect(vi.mocked(fs.existsSync).mock.calls.length).toBeLessThanOrEqual(2 * deliveries)
      expect(stateReads).toBe(1) // Cold first read, then metadata-validated login cache.
      expect(vi.mocked(fs.readFileSync).mock.calls[0][0]).toBe(stateFile)
      expect(fs.readdirSync).not.toHaveBeenCalled()
      console.info('account-home-perf', {
        accounts,
        deliveries,
        signedIn,
        selectionReads,
        accountVisits,
        stats,
        directoryStats,
        stateReads,
        stateBytes: Buffer.byteLength(state),
        elapsedMs
      })
    }
  }
})
