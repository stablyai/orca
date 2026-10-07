import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  setActiveLineageContext,
  getActiveLineageContext,
  clearActiveLineageContext,
  injectLineageEnv
} from '../../../src/main/lineage/pty-env-injector'

describe('pty-env-injector', () => {
  beforeEach(() => {
    clearActiveLineageContext()
  })

  afterEach(() => {
    clearActiveLineageContext()
  })

  it('injects lineage env into pty', () => {
    // 1. Set active session in Control Tower
    setActiveLineageContext({
      parentWorkspaceKey: 'folder:control-tower-workspace',
      parentSessionId: 'sess-control-tower-99'
    })

    // 2. Base PTY environment
    const ptyBaseEnv: Record<string, string> = {
      TERM: 'xterm-256color',
      PATH: '/usr/bin:/bin'
    }

    // 3. Inject lineage environment into PTY
    const injected = injectLineageEnv(ptyBaseEnv)

    expect(injected.ORCA_PARENT_WORKSPACE_KEY).toBe('folder:control-tower-workspace')
    expect(injected.ORCA_PARENT_SESSION_ID).toBe('sess-control-tower-99')
    expect(process.env.ORCA_PARENT_WORKSPACE_KEY).toBe('folder:control-tower-workspace')
    expect(process.env.ORCA_PARENT_SESSION_ID).toBe('sess-control-tower-99')
  })

  it('supports explicit context override during injection', () => {
    const ptyBaseEnv: Record<string, string> = {}
    injectLineageEnv(ptyBaseEnv, {
      parentWorkspaceKey: 'worktree:custom-parent',
      parentSessionId: 'custom-session'
    })

    expect(ptyBaseEnv.ORCA_PARENT_WORKSPACE_KEY).toBe('worktree:custom-parent')
    expect(ptyBaseEnv.ORCA_PARENT_SESSION_ID).toBe('custom-session')
  })

  it('cleans up environment when active lineage context is cleared', () => {
    setActiveLineageContext({
      parentWorkspaceKey: 'folder:tower-1',
      parentSessionId: 'sess-1'
    })
    expect(getActiveLineageContext()).not.toBeNull()

    clearActiveLineageContext()
    expect(getActiveLineageContext()).toBeNull()
    expect(process.env.ORCA_PARENT_WORKSPACE_KEY).toBeUndefined()
    expect(process.env.ORCA_PARENT_SESSION_ID).toBeUndefined()

    const env: Record<string, string> = {}
    injectLineageEnv(env)
    expect(env.ORCA_PARENT_WORKSPACE_KEY).toBeUndefined()
    expect(env.ORCA_PARENT_SESSION_ID).toBeUndefined()
  })
})
