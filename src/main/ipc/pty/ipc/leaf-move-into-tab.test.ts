import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { agentHookServer } from '../../../agent-hooks/server'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type {
  TerminalLeafIntoTabRequest,
  TerminalLeafIntoTabResult
} from '../../../../shared/terminal-leaf-move'
import {
  clearMigrationUnsupportedPty,
  getMigrationUnsupportedPtySnapshot,
  setMigrationUnsupportedPty
} from '../../../agent-hooks/migration-unsupported-pty-state'
import { noopPtyIpcSurface, setPtyHostBindings } from '../../pty-host-bindings'
import {
  getPtyIdForPaneKey,
  paneKeyPtyId,
  ptyPaneKey,
  rememberPaneKeyForPty
} from '../pane/key-state'
import { commitLeafIntoTabAndRekey, installPtyLeafMoveIpcHandler } from './leaf-move'

// The window-applied join under test exists only while the layout-owner switch is off.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

const LEAF = '22222222-2222-4222-8222-222222222222'
const TARGET_LEAF = '11111111-1111-4111-8111-111111111111'
const request: TerminalLeafIntoTabRequest = {
  worktreeId: 'repo-1::/tmp/wt',
  sourceTabId: 'tab-source',
  targetTabId: 'tab-target',
  targetLeafId: TARGET_LEAF,
  leafId: LEAF,
  ptyId: 'pty-agent',
  placement: { kind: 'beside', side: 'right' }
}
const FROM_KEY = `tab-source:${LEAF}`
const TO_KEY = `tab-target:${LEAF}`
const moved: TerminalLeafIntoTabResult = {
  status: 'moved',
  ptyId: 'pty-agent',
  sourceTabClosed: true
}

function deps(result: TerminalLeafIntoTabResult) {
  const rekeyWorkerTerminalResourcePaneKey = vi.fn(() => 1)
  const restampMovedPtySurface = vi.fn()
  const moveTerminalLeafIntoTab = vi.fn(async () => result)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move reads only this Store method.
  const store = { moveTerminalLeafIntoTab } as unknown as Store
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move reads only these runtime members.
  const runtime = {
    getExistingOrchestrationDb: () => ({ rekeyWorkerTerminalResourcePaneKey }),
    restampMovedPtySurface
  } as unknown as OrcaRuntimeService
  return {
    store,
    runtime,
    rekeyWorkerTerminalResourcePaneKey,
    restampMovedPtySurface,
    moveTerminalLeafIntoTab
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  ptyPaneKey.clear()
  paneKeyPtyId.clear()
  clearMigrationUnsupportedPty('pty-agent')
  setPtyHostBindings({})
})

describe('pty:moveLeafIntoTab', () => {
  it('re-keys every main-side identity after a committed join', async () => {
    const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    rememberPaneKeyForPty('pty-agent', FROM_KEY)
    setMigrationUnsupportedPty({
      ptyId: 'pty-agent',
      tabId: 'tab-source',
      paneKey: FROM_KEY,
      reason: 'legacy-numeric-pane-key',
      source: 'local',
      updatedAt: 1
    })
    const { store, runtime, rekeyWorkerTerminalResourcePaneKey, restampMovedPtySurface } =
      deps(moved)

    await expect(commitLeafIntoTabAndRekey({ store, runtime }, request)).resolves.toEqual(moved)

    expect(transfer).toHaveBeenCalledWith(FROM_KEY, TO_KEY, 'pty-agent', expect.any(Number), {
      authorityVerified: true
    })
    expect(getPtyIdForPaneKey(TO_KEY)).toBe('pty-agent')
    expect(getPtyIdForPaneKey(FROM_KEY)).toBeUndefined()
    expect(restampMovedPtySurface).toHaveBeenCalledWith('pty-agent', 'tab-target', TO_KEY)
    expect(getMigrationUnsupportedPtySnapshot()).toEqual([
      expect.objectContaining({ ptyId: 'pty-agent', paneKey: TO_KEY, tabId: 'tab-target' })
    ])
    expect(rekeyWorkerTerminalResourcePaneKey).toHaveBeenCalledWith({
      fromPaneKey: FROM_KEY,
      toPaneKey: TO_KEY
    })
  })

  it.each<TerminalLeafIntoTabResult>([
    { status: 'not_held' },
    { status: 'refused', reason: 'source_not_single_leaf' }
  ])('leaves every pane key alone when nothing was applied (%o)', async (result) => {
    const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    const { store, runtime, rekeyWorkerTerminalResourcePaneKey, restampMovedPtySurface } =
      deps(result)
    rememberPaneKeyForPty('pty-agent', FROM_KEY)

    await expect(commitLeafIntoTabAndRekey({ store, runtime }, request)).resolves.toEqual(result)

    expect(transfer).not.toHaveBeenCalled()
    expect(restampMovedPtySurface).not.toHaveBeenCalled()
    expect(rekeyWorkerTerminalResourcePaneKey).not.toHaveBeenCalled()
    expect(getPtyIdForPaneKey(FROM_KEY)).toBe('pty-agent')
  })

  it('answers not_held when no store backs this host', async () => {
    await expect(commitLeafIntoTabAndRekey({}, request)).resolves.toEqual({ status: 'not_held' })
  })

  it('rejects a malformed request before touching the store', async () => {
    const { store, runtime, moveTerminalLeafIntoTab } = deps(moved)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, args: unknown) => unknown>()
    setPtyHostBindings({
      ipc: { ...noopPtyIpcSurface, handle: (channel, listener) => handlers.set(channel, listener) }
    })
    installPtyLeafMoveIpcHandler({ store, runtime })

    const handler = handlers.get('pty:moveLeafIntoTab')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler never reads the event.
    const event = {} as IpcMainInvokeEvent
    await expect(
      handler?.(event, { ...request, targetTabId: request.sourceTabId })
    ).resolves.toEqual({
      status: 'refused',
      reason: 'invalid_request'
    })
    expect(moveTerminalLeafIntoTab).not.toHaveBeenCalled()
  })
})
