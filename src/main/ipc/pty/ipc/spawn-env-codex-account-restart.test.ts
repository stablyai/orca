import { describe, expect, it, vi } from 'vitest'

const { hostEnv } = vi.hoisted(() => ({
  hostEnv: {
    resolvePtySpawnHostEnv: vi.fn(async () => ({
      codexResumeLaunch: { droppedResumeArgv: false },
      launchCommand: 'codex resume thread-1',
      baseEnv: {},
      env: {},
      selectedCodexHomePath: null,
      codexResumeHomeSelected: false,
      skipCodexHomeEnv: false,
      stripInheritedOrcaCodexHome: false
    }))
  }
}))
vi.mock('../host-env/spawn-host-env', () => hostEnv)
vi.mock('../../../runtime/terminal/output/terminal-model-query-authority', () => ({
  isNativeWindowsLocalPtySpawn: () => false
}))

import { assemblePtyIpcSpawnCodexEnv } from './spawn-env-codex'
import {
  codexAccountRestartPaneKey,
  codexAccountRestartStops
} from '../account-restart/codex-account-restart-stops'
import type { PtyIpcSpawnState } from './spawn-state'

const pane = { worktreeId: 'wt', tabId: 'tab', leafId: 'leaf-unspend' }
const session = { key: 'session_id' as const, id: 'thread-1' }

async function admitProvenStop(): Promise<void> {
  await codexAccountRestartStops.request(
    { ...pane, ptyId: 'pty-a', opId: 'op-1' },
    {
      resolveOccupant: () => ({
        ptyId: 'pty-a',
        incarnationId: 'inc-unspend',
        provenance: { threadId: 'thread-1', transcriptPath: '/old/rollout-thread-1.jsonl' }
      }),
      stop: async () => 'ended'
    }
  )
}

function spawnState(): PtyIpcSpawnState {
  const fields = {
    args: { ...pane, launchAgent: 'codex', resumeProviderSession: session },
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
    ctx.unspendCodexAccountRestart?.()
    await expect(
      codexAccountRestartStops.resolveResume({ paneKey, providerSession: session })
    ).resolves.toMatchObject({ kind: 'selected' })
  })
})
