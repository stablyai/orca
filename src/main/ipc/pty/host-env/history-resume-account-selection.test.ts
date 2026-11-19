import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { HistoryResumePlanner } from '../../../providers/accounts/history-resume-planner'
import { HistoryContinuationLedger } from '../../../providers/accounts/history-continuation-ledger'
import {
  WorkspaceAccountSessionResume,
  installWorkspaceAccountSessionResume
} from '../../../providers/accounts/workspace-account-session-resume'
import { makeRuntimePtySpawnTestDeps } from '../runtime/spawn-preflight-test-deps-fixture'
import { resolveCodexResumeLaunch } from './codex-resume'
import { resolvePtySpawnHostEnv } from './spawn-host-env'

vi.mock('../../../codex/history/index/codex-state-db-backfill-recovery', () => ({
  ensureCodexStateDbBackfillRecoveryStarted: async () => {}
}))

let root: string
let hostHome: string
let workHome: string
let receipt: string
let transcriptPath: string
const sessionId = '00000000-0000-4000-8000-000000000031'
const workspaceId = 'folder:project'

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-history-spawn-')))
  hostHome = join(root, 'host')
  workHome = join(root, 'work')
  const workspace = join(root, 'project')
  const directory = join(workHome, 'sessions', '2026', '11', '19')
  await Promise.all(
    [hostHome, workspace, directory].map((path) => mkdir(path, { recursive: true }))
  )
  await Promise.all(
    [hostHome, workHome].map((home) =>
      writeFile(join(home, 'auth.json'), '{"OPENAI_API_KEY":"test-key"}')
    )
  )
  transcriptPath = join(directory, `rollout-2026-11-19T10-00-00-${sessionId}.jsonl`)
  await writeFile(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: workspace } })}\n`
  )
  const ledger = new HistoryContinuationLedger(join(root, 'ledger.json'))
  await ledger.record({
    provider: 'codex',
    sessionId,
    filePath: transcriptPath,
    home: workHome,
    rootSessionId: sessionId,
    accountId: 'work',
    openedAt: 1
  })
  const planner = new HistoryResumePlanner({
    ledger,
    roots: async () => [join(workHome, 'sessions'), join(hostHome, 'sessions')],
    workspacePath: () => workspace,
    accounts: () => ({
      accounts: [
        { id: 'host', label: 'Host', available: true },
        { id: 'work', label: 'Work', available: true }
      ]
    }),
    prepareAccount: async (_provider, id) => (id === 'work' ? workHome : hostHome),
    heal: async () => ({
      outcome: 'completed',
      healedThreads: 1,
      missingThreads: 0,
      failedThreads: 0
    })
  })
  installWorkspaceAccountSessionResume(new WorkspaceAccountSessionResume(planner))
  const args = {
    agent: 'codex' as const,
    sessionId,
    filePath: transcriptPath,
    codexHome: workHome,
    executionHostId: 'local' as const,
    workspaceId
  }
  const preview = await planner.prepare({ ...args, preview: true })
  const prepared = await planner.prepare({
    ...args,
    planToken: preview.resumePlan!.token,
    resumeAccountId: 'work'
  })
  receipt = prepared.resumeReceipt!
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function launch(resumeReceipt?: string) {
  const providerSession = { key: 'session_id' as const, id: sessionId, transcriptPath }
  const deps = makeRuntimePtySpawnTestDeps()
  const settings = getDefaultSettings(root)
  settings.codexManagedAccounts = ['host', 'work'].map((id) => ({
    id,
    email: `${id}@example.com`,
    managedHomePath: id === 'work' ? workHome : hostHome,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }))
  settings.activeCodexManagedAccountId = 'host'
  settings.activeCodexManagedAccountIdsByRuntime = { host: 'host', wsl: {} }
  deps.getSettings = () => settings
  deps.getSelectedCodexHomePath = () => hostHome
  deps.prepareCodexResumeHome = () => ({
    providerSession,
    preparation: Promise.resolve({ outcome: 'resume', codexHomePath: hostHome })
  })
  deps.resolveCodexResumeLaunch = resolveCodexResumeLaunch
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: non-daemon host-env resolution returns before accessing the PTY provider.
  const provider = {} as IPtyProvider
  return resolvePtySpawnHostEnv({
    launchAgent: 'codex',
    command: `codex resume ${sessionId}`,
    resumeProviderSession: providerSession,
    env: resumeReceipt ? { ORCA_HISTORY_RESUME_RECEIPT: resumeReceipt } : undefined,
    cwd: join(root, 'project'),
    worktreeId: workspaceId,
    shellOverride: undefined,
    expectedWslDistro: null,
    codexSelectionTarget: { runtime: 'host' },
    preAdopted: false,
    isDaemonHostSpawn: false,
    sessionId: undefined,
    callerNamedSession: false,
    mintedSessionId: false,
    resumeOnSelectedAccount: true,
    emptySessionIdSkipsHostEnv: false,
    requestedAgentTeamsPath: undefined,
    provider,
    deps
  })
}

it.each([false, true])(
  'keeps the History account when replacing a pane, with host credentials missing: %s',
  async (missingHostAuth) => {
    if (missingHostAuth) {
      await rm(join(hostHome, 'auth.json'))
    }
    const result = await launch(receipt)
    expect(result.selectedCodexHomePath).toBe(workHome)
    expect(result.codexResumeHomeSelected).toBe(true)
    expect(result.codexResumeLaunch.providerSession?.id).toBe(
      '00000000-0000-4000-8000-000000000031'
    )
  }
)

it('keeps ordinary resume preparation for launches without a History receipt', async () => {
  expect((await launch()).selectedCodexHomePath).toBe(hostHome)
})

it('rejects an invalid History receipt instead of using the host account', async () => {
  await expect(launch('invalid-receipt')).rejects.toThrow()
})

it('still refuses a History account whose credentials are missing', async () => {
  await rm(join(workHome, 'auth.json'))
  await expect(launch(receipt)).rejects.toThrow()
})
