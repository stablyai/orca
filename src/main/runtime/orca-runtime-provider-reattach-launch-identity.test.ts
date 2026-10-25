import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { registerBoundPty } from './bind-first-pane.test-fixture'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

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

/** Switch-on, main's layout answers which pane holds a terminal, so the runtime needs a store. */
function createRuntime(): OrcaRuntimeService {
  return new OrcaRuntimeService(ORCA_LAYOUT_OWNER_IS_MAIN ? partialRuntimeStore() : null)
}

function paneKeyOf(runtime: OrcaRuntimeService, ptyId: string): string | null {
  const pty = runtime['ptysById'].get(ptyId)
  return runtime['paneOfPty'](pty).paneKey
}

describe('provider reattach launch identity', () => {
  it('restores daemon-owned agent identity without minting renderer authority', () => {
    const runtime = createRuntime()

    registerBoundPty(runtime, 'pty-reattach', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID,
      providerReattachLaunchIdentity: {
        incarnationId: INCARNATION_ID,
        launchAgent: 'codex'
      }
    })

    expect(paneKeyOf(runtime, 'pty-reattach')).toBe(PANE_KEY)
    expect(getPty(runtime, 'pty-reattach')).toMatchObject({
      incarnationId: INCARNATION_ID,
      launchAgent: 'codex',
      launchToken: null,
      launchIncarnationId: null
    })
  })

  it('rejects provider identity from a different process incarnation', () => {
    const runtime = createRuntime()

    registerBoundPty(runtime, 'pty-mismatched-reattach', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID,
      providerReattachLaunchIdentity: {
        incarnationId: 'stale-provider-incarnation',
        launchAgent: 'codex'
      }
    })

    expect(paneKeyOf(runtime, 'pty-mismatched-reattach')).toBe(PANE_KEY)
    expect(getPty(runtime, 'pty-mismatched-reattach')).toMatchObject({
      incarnationId: INCARNATION_ID,
      launchAgent: null,
      launchToken: null,
      launchIncarnationId: null
    })
  })

  it('retires daemon launch identity when the agent command finishes', () => {
    const runtime = createRuntime()

    registerBoundPty(runtime, 'pty-finished-reattach', WORKTREE_ID, null, {
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
