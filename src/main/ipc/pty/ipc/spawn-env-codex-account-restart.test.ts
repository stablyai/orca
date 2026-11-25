import { describe, expect, it, vi } from 'vitest'

const { hostEnv } = vi.hoisted(() => ({
  hostEnv: {
    resolvePtySpawnHostEnv: vi.fn(
      async (args: { deps: { getSelectedCodexHomePath?: () => unknown } }) => {
        // The real assembly picks the launch home here.
        await args.deps.getSelectedCodexHomePath?.()
        return {
          codexResumeLaunch: { droppedResumeArgv: false },
          launchCommand: 'codex resume thread-1',
          baseEnv: {},
          env: {},
          selectedCodexHomePath: null,
          codexResumeHomeSelected: false,
          skipCodexHomeEnv: false,
          stripInheritedOrcaCodexHome: false
        }
      }
    )
  }
}))
vi.mock('../host-env/spawn-host-env', () => hostEnv)
vi.mock('../../../runtime/terminal/output/terminal-model-query-authority', () => ({
  isNativeWindowsLocalPtySpawn: () => false
}))

import {
  assemblePtyIpcSpawnCodexEnv,
  noteCodexAccountRestartLaunchDispatched,
  restoreUnstartedCodexAccountRestart
} from './spawn-env-codex'
import {
  codexAccountRestartPaneKey,
  codexAccountRestartStops
} from '../account-restart/codex-account-restart-stops'
import type { PtyIpcSpawnState } from './spawn-state'

let paneCounter = 0
const nextPane = () => ({ worktreeId: 'wt', tabId: 'tab', leafId: `leaf-${++paneCounter}` })
let pane = nextPane()
const session = { key: 'session_id' as const, id: 'thread-1' }

async function admitProvenStop(): Promise<void> {
  await codexAccountRestartStops.request(
    { ...pane, ptyId: 'pty-a', opId: 'op-1' },
    {
      resolveOccupant: () => ({
        ptyId: 'pty-a',
        incarnationId: `inc-${pane.leafId}`,
        provenance: { threadId: 'thread-1', transcriptPath: '/old/rollout-thread-1.jsonl' }
      }),
      stop: async () => 'ended'
    }
  )
}

function spawnState(): PtyIpcSpawnState {
  const fields = {
    args: { ...pane, launchAgent: 'codex', resumeProviderSession: session },
    deps: {},
    terminalRuntimeOptions: {},
    validatedLeafId: pane.leafId,
    preAdoptedStablePane: null,
    codexSelectionTarget: { runtime: 'host', wslDistro: null },
    isDaemonHostSpawn: true,
    spawnTiming: { mark: () => {} },
    unspendCodexAccountRestart: null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: env assembly reads only these fields.
  return fields as unknown as PtyIpcSpawnState
}

describe('Codex env assembly for an account restart resume', () => {
  it('keeps a restore for a spawn that fails or retires after its env was assembled', async () => {
    pane = nextPane()
    await admitProvenStop()
    const ctx = spawnState()
    await assemblePtyIpcSpawnCodexEnv(ctx)
    expect(hostEnv.resolvePtySpawnHostEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeOnSelectedAccount: true,
        resumeProviderSession: { ...session, transcriptPath: '/old/rollout-thread-1.jsonl' }
      })
    )
    const paneKey = codexAccountRestartPaneKey(pane)
    // Spent: a concurrent resume cannot take the switch while this spawn is in flight.
    await expect(
      codexAccountRestartStops.resolveResume({ paneKey, providerSession: session })
    ).resolves.toEqual({ kind: 'none' })
    // The process never started, so the spawn's preparation release restores it.
    restoreUnstartedCodexAccountRestart(ctx)
    await expect(
      codexAccountRestartStops.resolveResume({ paneKey, providerSession: session })
    ).resolves.toMatchObject({ kind: 'selected' })
  })

  it('never restores the intent once the provider spawn was dispatched', async () => {
    pane = nextPane()
    await admitProvenStop()
    const ctx = spawnState()
    await assemblePtyIpcSpawnCodexEnv(ctx)
    noteCodexAccountRestartLaunchDispatched(ctx)
    // A later failure (binding save, registration) may follow a started child.
    restoreUnstartedCodexAccountRestart(ctx)
    await expect(
      codexAccountRestartStops.resolveResume({
        paneKey: codexAccountRestartPaneKey(pane),
        providerSession: session
      })
    ).resolves.toEqual({ kind: 'none' })
  })

  it('a Dismiss while the intent is spent still holds after an unstarted spawn restores it', async () => {
    pane = nextPane()
    await admitProvenStop()
    const ctx = spawnState()
    await assemblePtyIpcSpawnCodexEnv(ctx)
    expect(codexAccountRestartStops.withdraw({ ...pane, opId: 'op-1' })).toBe(true)
    restoreUnstartedCodexAccountRestart(ctx)
    await expect(
      codexAccountRestartStops.resolveResume({
        paneKey: codexAccountRestartPaneKey(pane),
        providerSession: session
      })
    ).resolves.toEqual({ kind: 'pinned' })
  })

  it('attributes the child with the account selected when its home was chosen', async () => {
    pane = nextPane()
    const settings = { activeCodexManagedAccountId: 'account-a', codexManagedAccounts: [] }
    const ctx = spawnState()
    Object.assign(ctx, {
      args: { ...pane, launchAgent: 'codex' },
      deps: {
        getSettings: () => settings,
        getSelectedCodexHomePath: () => '/homes/account-a'
      }
    })
    await assemblePtyIpcSpawnCodexEnv(ctx)
    // The user switches before the spawn publishes its attribution.
    settings.activeCodexManagedAccountId = 'account-b'
    expect(ctx.codexLaunchSettings?.activeCodexManagedAccountId).toBe('account-a')
  })
})
