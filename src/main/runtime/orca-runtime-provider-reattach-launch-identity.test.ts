import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const INCARNATION_ID = 'provider-reattach-incarnation'
const WORKTREE_ID = 'repo-1::/tmp/provider-reattach'

type RuntimePtyLaunchIdentity = {
  incarnationId: string | null
  paneKey: string | null
  launchAgent: string | null
  launchToken: string | null
  launchIncarnationId: string | null
}

function getPty(runtime: OrcaRuntimeService, ptyId: string): RuntimePtyLaunchIdentity | undefined {
  return (runtime as unknown as { ptysById: Map<string, RuntimePtyLaunchIdentity> }).ptysById.get(
    ptyId
  )
}

describe('provider reattach launch identity', () => {
  it('restores daemon-owned agent identity without minting renderer authority', () => {
    const runtime = new OrcaRuntimeService(null)

    runtime.registerPty('pty-reattach', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID,
      providerReattachLaunchIdentity: {
        incarnationId: INCARNATION_ID,
        launchAgent: 'codex'
      }
    })

    expect(getPty(runtime, 'pty-reattach')).toMatchObject({
      incarnationId: INCARNATION_ID,
      paneKey: PANE_KEY,
      launchAgent: 'codex',
      launchToken: null,
      launchIncarnationId: null
    })
  })

  it('rejects provider identity from a different process incarnation', () => {
    const runtime = new OrcaRuntimeService(null)

    runtime.registerPty('pty-mismatched-reattach', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID,
      providerReattachLaunchIdentity: {
        incarnationId: 'stale-provider-incarnation',
        launchAgent: 'codex'
      }
    })

    expect(getPty(runtime, 'pty-mismatched-reattach')).toMatchObject({
      incarnationId: INCARNATION_ID,
      paneKey: PANE_KEY,
      launchAgent: null,
      launchToken: null,
      launchIncarnationId: null
    })
  })

  it('retires daemon launch identity when the agent command finishes', () => {
    const runtime = new OrcaRuntimeService(null)

    runtime.registerPty('pty-finished-reattach', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID,
      providerReattachLaunchIdentity: {
        incarnationId: INCARNATION_ID,
        launchAgent: 'codex'
      }
    })
    runtime.emitDaemonPtyTransientFact('pty-finished-reattach', {
      kind: 'command-finished',
      exitCode: 0
    })

    expect(getPty(runtime, 'pty-finished-reattach')).toMatchObject({
      launchAgent: null,
      launchToken: null,
      launchIncarnationId: null
    })
  })
})
