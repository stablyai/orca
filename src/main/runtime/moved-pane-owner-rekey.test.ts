import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHookServer } from '../agent-hooks/server'
import {
  clearMigrationUnsupportedPty,
  getMigrationUnsupportedPtySnapshot,
  setMigrationUnsupportedPty,
  setMigrationUnsupportedPtyListener
} from '../agent-hooks/migration-unsupported-pty-state'
import {
  getPtyIdForPaneKey,
  paneKeyPtyId,
  ptyPaneKey,
  rememberPaneKeyForPty
} from '../ipc/pty/pane/key-state'
import type { TerminalLeafMoveRequest } from '../../shared/terminal-leaf-move'
import { rekeyMovedPaneOwners } from './moved-pane-owner-rekey'
import type { OrcaRuntimeService } from './orca-runtime'

const LEAF = '22222222-2222-4222-8222-222222222222'
const FROM_KEY = `tab-source:${LEAF}`
const TO_KEY = `tab-target:${LEAF}`
const request: TerminalLeafMoveRequest = {
  worktreeId: 'wt-1',
  sourceTabId: 'tab-source',
  targetTabId: 'tab-target',
  leafId: LEAF,
  ptyId: 'pty-agent'
}

function runtimeStub() {
  const rekeyWorkerTerminalResourcePaneKey = vi.fn(() => 1)
  const restampMovedPtySurface = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rekey reads only these two runtime members.
  const runtime = {
    getExistingOrchestrationDb: () => ({ rekeyWorkerTerminalResourcePaneKey }),
    restampMovedPtySurface
  } as unknown as OrcaRuntimeService
  return { runtime, rekeyWorkerTerminalResourcePaneKey, restampMovedPtySurface }
}

function unsupportedEntry() {
  return {
    ptyId: 'pty-agent',
    tabId: 'tab-source',
    paneKey: FROM_KEY,
    reason: 'legacy-numeric-pane-key' as const,
    source: 'local' as const,
    updatedAt: 1
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  ptyPaneKey.clear()
  paneKeyPtyId.clear()
  clearMigrationUnsupportedPty('pty-agent')
})

describe('rekeyMovedPaneOwners', () => {
  it('moves the pane-key lookups to the new key, and exit cleanup then finds them', () => {
    vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    rememberPaneKeyForPty('pty-agent', FROM_KEY)

    rekeyMovedPaneOwners(runtimeStub().runtime, request)

    expect(getPtyIdForPaneKey(TO_KEY)).toBe('pty-agent')
    expect(getPtyIdForPaneKey(FROM_KEY)).toBeUndefined()
    expect(ptyPaneKey.get('pty-agent')).toBe(TO_KEY)
  })

  it('re-stamps the runtime PTY record with the new tab and pane key', () => {
    vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    const { runtime, restampMovedPtySurface } = runtimeStub()

    rekeyMovedPaneOwners(runtime, request)

    expect(restampMovedPtySurface).toHaveBeenCalledWith('pty-agent', 'tab-target', TO_KEY)
  })

  it('re-keys a migration-unsupported entry so closing the source tab keeps it', () => {
    vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    setMigrationUnsupportedPty(unsupportedEntry())

    rekeyMovedPaneOwners(runtimeStub().runtime, request)

    expect(getMigrationUnsupportedPtySnapshot()).toEqual([
      expect.objectContaining({ ptyId: 'pty-agent', paneKey: TO_KEY, tabId: 'tab-target' })
    ])
  })

  it('still re-stamps the runtime PTY record when the migration notification throws', () => {
    vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setMigrationUnsupportedPty(unsupportedEntry())
    // Why: a destroyed renderer makes the webContents send inside this listener throw.
    setMigrationUnsupportedPtyListener(() => {
      throw new Error('Object has been destroyed')
    })
    const { runtime, restampMovedPtySurface } = runtimeStub()
    rememberPaneKeyForPty('pty-agent', FROM_KEY)

    try {
      expect(() => rekeyMovedPaneOwners(runtime, request)).not.toThrow()
    } finally {
      setMigrationUnsupportedPtyListener(null)
    }

    expect(restampMovedPtySurface).toHaveBeenCalledWith('pty-agent', 'tab-target', TO_KEY)
    expect(getPtyIdForPaneKey(TO_KEY)).toBe('pty-agent')
  })

  it('still re-keys the lookups and the migration entry when the restamp throws', () => {
    vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setMigrationUnsupportedPty(unsupportedEntry())
    rememberPaneKeyForPty('pty-agent', FROM_KEY)
    const { runtime, restampMovedPtySurface } = runtimeStub()
    restampMovedPtySurface.mockImplementation(() => {
      throw new Error('restamp failed')
    })

    expect(() => rekeyMovedPaneOwners(runtime, request)).not.toThrow()

    expect(getPtyIdForPaneKey(TO_KEY)).toBe('pty-agent')
    expect(getMigrationUnsupportedPtySnapshot()).toEqual([
      expect.objectContaining({ paneKey: TO_KEY })
    ])
  })

  it('touches no PTY lookup or runtime record for a move with no PTY', () => {
    vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    const { runtime, restampMovedPtySurface } = runtimeStub()

    rekeyMovedPaneOwners(runtime, { ...request, ptyId: null })

    expect(restampMovedPtySurface).not.toHaveBeenCalled()
    expect(paneKeyPtyId.size).toBe(0)
  })
})
