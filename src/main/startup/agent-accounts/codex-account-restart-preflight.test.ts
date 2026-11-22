import { dirname, join } from 'node:path'
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  prepareCodexResumeHome,
  resolveCodexResumeLaunch,
  stripSequencedStartupResumeArgv
} from '../../ipc/pty/host-env/codex-resume'
import { beginAccountRestartOperation } from '../../ipc/pty/pane/account-restart-owner'
import { prepareRuntimePtySpawn } from '../../ipc/pty/runtime/spawn-preflight'
import { makeRuntimePtySpawnTestDeps } from '../../ipc/pty/runtime/spawn-preflight-test-deps-fixture'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'

const homes = vi.hoisted(() => ({ original: '', selected: '', system: '' }))
vi.mock('../../codex/trust/project-trust/codex-project-trust-worker-spawn', async () => ({
  spawnCodexProjectTrustWorker: (
    await import('../../codex/trust/project-trust/codex-project-trust-worker.test-fixture')
  ).codexProjectTrustTestWorker.factory
}))
vi.mock('electron', () => ({ app: { getPath: () => homes.system } }))
vi.mock('../main-process-state', () => ({
  mainProcessState: {
    core: {
      codexRuntimeHome: {
        isHostSystemDefaultRealHomeSelected: () => false,
        prepareAccountHistoryForPinnedHome: async () => {},
        getHostCodexHomePathsForSessionDiscovery: () => [
          homes.original,
          homes.selected,
          join(homes.system, 'legacy')
        ],
        resolveSelectedHostAccountCodexHomePathForResume: () => homes.selected || null
      }
    },
    store: { getSettings: () => ({}) }
  }
}))
vi.mock('../../codex/hooks/installation/hook-service', () => ({
  codexHookService: {
    installForLaunchPrep: vi.fn(),
    refreshRuntimeUserHooksForLaunchPrep: vi.fn()
  }
}))
vi.mock('../../codex/hooks/reconciliation/codex-hook-reconcile', () => ({
  reconcileCodexHooksForLaunch: vi.fn()
}))
vi.mock('../../codex/configuration/homes/codex-home-paths', () => ({
  getCodexSessionBackfillStateDirPath: () => join(homes.system, 'backfill'),
  getSystemCodexHomePath: () => homes.system,
  getOrcaManagedCodexHomePath: () => join(homes.system, 'legacy'),
  resolveOrcaManagedCodexHomePath: () => join(homes.system, 'legacy')
}))
vi.mock('../../codex/configuration/settings/codex-config-mirror', () => ({
  ensureCodexDaemonSocketGuard: vi.fn()
}))

import { prepareCodexSessionResumeForLaunch } from './codex-session-resume-launch'

let root: string
let transcriptPath: string
const sessionId = 'abcdef00-1234-4321-9999-cafecafecafe'
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-account-restart-'))
  homes.original = join(root, 'codex-accounts', 'old', 'home')
  homes.selected = join(root, 'codex-accounts', 'new', 'home')
  homes.system = join(root, 'system')
  const relativePath = join('sessions', '2026', '10', '05', `rollout-${sessionId}.jsonl`)
  transcriptPath = join(homes.original, relativePath)
  const bridged = join(homes.selected, relativePath)
  mkdirSync(dirname(transcriptPath), { recursive: true })
  mkdirSync(dirname(bridged), { recursive: true })
  writeFileSync(transcriptPath, '{"type":"session_meta"}\n')
  linkSync(transcriptPath, bridged)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function prepareRuntimeResumeHome(
  accountRestart?: ReturnType<typeof beginAccountRestartOperation>
) {
  const state = createRuntimePtySpawnState(
    {
      ...makeRuntimePtySpawnTestDeps(),
      prepareCodexResumeHome: (args) =>
        prepareCodexResumeHome(prepareCodexSessionResumeForLaunch, args),
      resolveCodexResumeLaunch,
      stripSequencedStartupResumeArgv,
      getSelectedCodexHomePath: () => homes.selected
    },
    {
      cols: 80,
      rows: 24,
      cwd: root,
      launchAgent: 'codex',
      command: `codex resume ${sessionId}`,
      resumeProviderSession: { key: 'session_id', id: sessionId, transcriptPath }
    }
  )
  state.accountRestartOperation = accountRestart
  await prepareRuntimePtySpawn(state)
  return state.selectedCodexHomePath
}

it('resumes an explicit account restart in the selected home using the bridged transcript', async () => {
  const restart = beginAccountRestartOperation({
    requestId: 'request-1',
    attemptId: 'attempt-1',
    hostEpoch: 'host-1',
    pane: {
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      tabCreatedAt: 1
    },
    expected: { kind: 'empty', bindingGeneration: 1 }
  })
  await expect(prepareRuntimeResumeHome(restart)).resolves.toBe(homes.selected)
})

it('keeps ordinary automatic restores pinned to their original account', async () => {
  await expect(prepareRuntimeResumeHome()).resolves.toBe(homes.original)
})
