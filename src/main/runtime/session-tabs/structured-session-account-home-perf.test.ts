import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
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
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fsp>()
  return { ...actual, stat: vi.fn(actual.stat), readFile: vi.fn(actual.readFile) }
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
  for (const [signedIn, concurrent] of [
    [true, false],
    [false, false],
    [true, true],
    [false, true]
  ]) {
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
      const reads = vi.spyOn(router, 'selectedProfile')
      for (const spy of [
        fs.statSync,
        fs.lstatSync,
        fs.existsSync,
        fs.readFileSync,
        fs.readdirSync,
        fsp.stat,
        fsp.readFile
      ]) {
        vi.mocked(spy).mockClear()
      }
      accountVisits = 0
      selectionReads = 0
      const record = agentSessionRecordFixture()
      const deliver = () => runtime.resolveStructuredAgentLaunchAccountHome(record)
      const answers: (AgentSessionAccountHome | null)[] = []
      const started = performance.now()
      if (concurrent) {
        // Many chats reading at once on a cold cache, before any read has finished.
        answers.push(...(await Promise.all(Array.from({ length: deliveries }, deliver))))
      } else {
        for (let delivery = 0; delivery < deliveries; delivery += 1) {
          answers.push(await deliver())
        }
      }
      const elapsedMs = performance.now() - started
      expect(answers).toEqual(
        Array.from({ length: deliveries }, () => ({
          variable: 'CLAUDE_CONFIG_DIR',
          path: signedIn ? selectedHome : systemHome
        }))
      )
      const stats = vi.mocked(fsp.stat).mock.calls.length
      const stateReads = vi.mocked(fsp.readFile).mock.calls.length
      expect(reads).toHaveBeenCalledTimes(deliveries)
      expect(selectionReads).toBe(deliveries)
      expect(accountVisits).toBe(signedIn ? 0 : accounts * deliveries)
      // Chat reads run on main once per options read and send: nothing here may block it.
      for (const spy of [
        fs.statSync,
        fs.lstatSync,
        fs.existsSync,
        fs.readFileSync,
        fs.readdirSync
      ]) {
        expect(spy).not.toHaveBeenCalled()
      }
      // Cold first read (shared by concurrent readers), then metadata-validated login cache.
      expect(stateReads).toBe(1)
      expect(vi.mocked(fsp.readFile).mock.calls[0][0]).toBe(stateFile)
      if (concurrent) {
        // Claude rewrote the file: one more read for the new revision, however many readers.
        fs.writeFileSync(stateFile, `${state} `)
        await Promise.all(Array.from({ length: deliveries }, deliver))
        expect(vi.mocked(fsp.readFile).mock.calls.length).toBe(2)
      }
      console.info('account-home-perf', {
        accounts,
        deliveries,
        signedIn,
        concurrent,
        selectionReads,
        accountVisits,
        stats,
        stateReads,
        stateBytes: Buffer.byteLength(state),
        elapsedMs
      })
    }
  }
})
