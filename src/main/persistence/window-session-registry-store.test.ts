import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { createStore, readDataFile, testState } from '../persistence-test-harness'
import { WindowSessionRegistry } from './window-session-registry'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const HOST_ID = 'ssh:target-1'
const WORKTREE_ID = 'repo-1::/worktree'

function makeSession(owner: 'source' | 'target'): WorkspaceSessionState {
  const root = {
    type: 'split' as const,
    direction: 'horizontal' as const,
    first: { type: 'leaf' as const, leafId: 'leaf-source' },
    second: { type: 'leaf' as const, leafId: 'leaf-target' }
  }
  const leafId = `leaf-${owner}`
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    activeTabId: 'tab-1',
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab-1',
          worktreeId: WORKTREE_ID,
          title: 'tab-1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId: `pty-${owner}`
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root,
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: `pty-${owner}` },
        ...(owner === 'target'
          ? { scrollbackRefsByLeafId: { 'leaf-target': 'scrollback/target-ref' } }
          : {})
      }
    }
  }
}

function persistedTargetRef(): string | undefined {
  const state = readDataFile() as PersistedState
  return state.workspaceSessionsByHostId?.[HOST_ID]?.terminalLayoutsByTabId['tab-1']
    ?.scrollbackRefsByLeafId?.['leaf-target']
}

describe('WindowSessionRegistry durable writes', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-window-session-registry-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('persists target-only scrollback before and after the source removes its tab', async () => {
    const store = await createStore()
    const manager = { getControlWindow: () => ({ id: 1 }) }
    const registry = new WindowSessionRegistry(store, manager as never)
    registry.set(1, makeSession('source'), HOST_ID)
    registry.set(2, makeSession('target'), HOST_ID)

    store.flushOrThrow()
    expect(persistedTargetRef()).toBe('scrollback/target-ref')

    registry.set(1, getDefaultWorkspaceSession(), HOST_ID)
    store.flushOrThrow()
    expect(persistedTargetRef()).toBe('scrollback/target-ref')
  })
})
