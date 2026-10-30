import { describe, expect, it, vi, afterEach } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_PATH, store } from '../orca-runtime-test-fixtures.spec'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'

// `agent.launch` settles a launch as failed only when its create threw before this hook ran.
describe('OrcaRuntimeService createTerminal spawn dispatch', () => {
  it('reports the spawn request before it leaves for the pty controller', async () => {
    const dispatched = vi.fn()
    const spawn = vi.fn(async () => {
      expect(dispatched).toHaveBeenCalledOnce()
      return { id: 'pty-dispatch' }
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      onPtySpawnDispatched: dispatched
    })

    expect(spawn).toHaveBeenCalledOnce()
  })

  it('reports it even when the spawn itself then fails', async () => {
    const dispatched = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => {
        throw new Error('ssh_channel_closed')
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'codex',
        onPtySpawnDispatched: dispatched
      })
    ).rejects.toThrow('ssh_channel_closed')
    expect(dispatched).toHaveBeenCalledOnce()
  })

  it('does not report it when the create fails before any spawn request', async () => {
    const dispatched = vi.fn()
    const spawn = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal('path:/no/such/workspace', {
        command: 'codex',
        onPtySpawnDispatched: dispatched
      })
    ).rejects.toThrow()
    expect(spawn).not.toHaveBeenCalled()
    expect(dispatched).not.toHaveBeenCalled()
  })
})

describe('PTY registration dispatch characterization', () => {
  type PtyRegistrationBinding = NonNullable<Parameters<OrcaRuntimeService['registerPty']>[3]>
  const TAB_ID = '11111111-1111-4111-8111-111111111111'
  const LEAF_ID = '22222222-2222-4222-8222-222222222222'
  const PTY_ID = 'pty-dispatch'
  const WORKTREE_ID = 'repo::/tmp/dispatch'
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  class DispatchRuntime extends OrcaRuntimeService {
    constructor() {
      super(null)
      this.ensurePtyBackedMobileSurfaceForRendererTab = () => null
      this.touchMobileSessionSnapshotsForPty = () => {}
    }

    replaceAdmission(assertion: (ptyId: string, incarnationId?: string) => void): void {
      this.assertPtyDidNotExitBeforeRegistration = assertion
    }

    replaceHostScope(
      resolve: () => { kind: 'local'; hostId: 'local'; toJSON(): { kind: 'local' } } | null
    ): void {
      this.getOrchestrationCompatibilityHostScope = resolve
    }

    setDatabase(db: OrchestrationDb | null): void {
      this._orchestrationDb = db
    }

    get record() {
      return this.recordPtyWorktree
    }

    set record(value: typeof this.recordPtyWorktree) {
      this.recordPtyWorktree = value
    }

    get pendingCreates() {
      return this.pendingMobileTerminalCreatesByKey
    }

    get replacementFences() {
      return this.pendingPtyHandleReplacementFences
    }
  }

  function binding(): PtyRegistrationBinding {
    return { tabId: TAB_ID, leafId: LEAF_ID, incarnationId: 'dispatch-incarnation' }
  }

  function register(runtime: DispatchRuntime, tab: PtyRegistrationBinding): void {
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, tab)
  }

  describe('PTY runtime dispatch', () => {
    it('captures the admission method before reading the incarnation', () => {
      const runtime = new DispatchRuntime()
      runtime.replaceAdmission(function (this: DispatchRuntime) {
        expect(this).toBe(runtime)
        throw new Error('captured admission')
      })
      const tab = binding()
      Object.defineProperty(tab, 'incarnationId', {
        get() {
          runtime.replaceAdmission(() => {
            throw new Error('late admission')
          })
          return 'dispatch-incarnation'
        }
      })
      expect(() => register(runtime, tab)).toThrow('captured admission')
    })

    it('captures the record method before evaluating its state object', () => {
      const runtime = new DispatchRuntime()
      let reads = 0
      runtime.record = function (this: DispatchRuntime) {
        expect(this).toBe(runtime)
        throw new Error('captured record')
      }
      const tab = binding()
      Object.defineProperty(tab, 'tabId', {
        get() {
          if (++reads === 3) {
            runtime.record = () => {
              throw new Error('late record')
            }
          }
          return TAB_ID
        }
      })
      expect(() => register(runtime, tab)).toThrow('captured record')
    })

    it('skips database payload serialization when no database exists', () => {
      const runtime = new DispatchRuntime()
      let serializations = 0
      runtime.replaceHostScope(() => ({
        kind: 'local',
        hostId: 'local',
        toJSON() {
          serializations++
          return { kind: 'local' }
        }
      }))
      register(runtime, binding())
      expect(serializations).toBe(0)
    })

    it('skips a throwing database payload when no database exists', () => {
      const runtime = new DispatchRuntime()
      runtime.replaceHostScope(() => ({
        kind: 'local',
        hostId: 'local',
        toJSON() {
          throw new Error('absent database payload')
        }
      }))
      expect(() => register(runtime, binding())).not.toThrow()
    })

    it('keeps the database method and receiver captured before its payload', () => {
      const runtime = new DispatchRuntime()
      const captured = new OrchestrationDb(':memory:')
      const replacement = new OrchestrationDb(':memory:')
      databases.push(captured, replacement)
      const calls: string[] = []
      captured.retainReplacedWorkerTerminalResources = function () {
        expect(this).toBe(captured)
        calls.push('captured database')
        return 0
      }
      replacement.retainReplacedWorkerTerminalResources = () => calls.push('late database')
      runtime.setDatabase(captured)
      runtime.replaceHostScope(() => ({
        kind: 'local',
        hostId: 'local',
        toJSON() {
          runtime.setDatabase(replacement)
          return { kind: 'local' }
        }
      }))
      register(runtime, binding())
      expect(calls).toEqual(['captured database'])
    })

    it('captures the canonical map method before a binding getter changes it', () => {
      const runtime = new DispatchRuntime()
      let reads = 0
      const calls: string[] = []
      const map = runtime.pendingCreates
      map.has = () => {
        calls.push('captured map')
        return true
      }
      const tab = binding()
      Object.defineProperty(tab, 'tabId', {
        get() {
          if (++reads === 3) {
            map.has = () => {
              calls.push('late map')
              return false
            }
          }
          return TAB_ID
        }
      })
      runtime.replaceHostScope(() => null)
      register(runtime, tab)
      expect(calls).toEqual(['captured map'])
    })

    it('completes the captured replacement fence without another map lookup', () => {
      const runtime = new DispatchRuntime()
      let recorded = false
      let captured = false
      let reads = 0
      const map = runtime.replacementFences
      const originalGet = map.get.bind(map)
      const first = {
        incarnationId: 'first',
        staleHandles: new Set<string>(),
        pendingRegistration: false
      }
      const replacement = {
        incarnationId: 'second',
        staleHandles: new Set<string>(),
        pendingRegistration: true
      }
      map.set(PTY_ID, first)
      map.get = function (id) {
        reads++
        const value = originalGet(id)
        if (recorded) {
          captured = true
        }
        return value
      }
      const record = runtime.record
      runtime.record = function (...args) {
        const value = record.apply(runtime, args)
        recorded = true
        return value
      }
      runtime.replaceHostScope(() => null)
      const tab = binding()
      Object.defineProperty(tab, 'incarnationId', {
        get() {
          if (captured) {
            map.set(PTY_ID, replacement)
          }
          return undefined
        }
      })
      register(runtime, tab)
      expect(reads).toBe(2)
      expect(replacement.pendingRegistration).toBe(true)
    })
  })
})
