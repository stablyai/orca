import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

export function registerTerminalPtyExitWaiterTests(): void {
  type RuntimeInternals = {
    recordPtyWorktree: (
      ptyId: string,
      worktreeId: string,
      state?: { connected?: boolean }
    ) => unknown
    ptyExitListenersByPtyId: Map<string, Set<unknown>>
    ptysById: Map<string, { connected: boolean; lastExitCode: number | null }>
  }

  function internals(runtime: OrcaRuntimeService): RuntimeInternals {
    return runtime as unknown as RuntimeInternals
  }

  function registerLivePty(runtime: OrcaRuntimeService): void {
    internals(runtime).recordPtyWorktree('pty-1', 'wt-1', { connected: true })
  }

  describe('PTY exit subscription', () => {
    it('fires on the backing PTY exit', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      const listener = vi.fn()

      runtime.subscribeToPtyExit('pty-1', listener)

      expect(internals(runtime).ptyExitListenersByPtyId.get('pty-1')).toHaveLength(1)

      runtime.onPtyExit('pty-1', 0)

      expect(listener).toHaveBeenCalledOnce()
      expect(internals(runtime).ptyExitListenersByPtyId.has('pty-1')).toBe(false)
    })

    it('does not retain listeners across subscription churn', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      const listener = vi.fn()

      for (let index = 0; index < 25; index += 1) {
        runtime.subscribeToPtyExit('pty-1', listener)()
      }
      runtime.onPtyExit('pty-1', 0)

      expect(listener).not.toHaveBeenCalled()
      expect(internals(runtime).ptyExitListenersByPtyId.has('pty-1')).toBe(false)
    })

    it('fires immediately when the PTY already exited', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      runtime.onPtyExit('pty-1', 0)
      const listener = vi.fn()

      runtime.subscribeToPtyExit('pty-1', listener)

      expect(listener).toHaveBeenCalledOnce()
      expect(internals(runtime).ptyExitListenersByPtyId.has('pty-1')).toBe(false)
    })
  })

  // Why: the liveness sweep clears `connected` with no exit code for every PTY behind a
  // dropped relay, so a record in that state is a lost connection to a process that may
  // still be running. Reading it as an exit retires a live lease and emits `end`, which the
  // phone rearms against three times and then locks the composer on "Waiting for terminal…".
  describe('PTY exit subscription demands proof of exit, not loss of connection', () => {
    function dropTheConnection(runtime: OrcaRuntimeService): void {
      const pty = internals(runtime).ptysById.get('pty-1')!
      pty.connected = false
      // Precondition: onPtyExit is the only writer of lastExitCode, and it never ran.
      expect(pty.lastExitCode).toBeNull()
    }

    it('does not fire for a disconnected PTY that never reported an exit code', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      dropTheConnection(runtime)
      const listener = vi.fn()

      runtime.subscribeToPtyExit('pty-1', listener)

      expect(listener).not.toHaveBeenCalled()
      expect(internals(runtime).ptyExitListenersByPtyId.get('pty-1')).toHaveLength(1)
    })

    it('still fires once the host comes back and reports the real exit', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      dropTheConnection(runtime)
      const listener = vi.fn()

      runtime.subscribeToPtyExit('pty-1', listener)
      expect(listener).not.toHaveBeenCalled()

      // Why: subscribing during the outage must not cost the subscriber the later exit.
      runtime.onPtyExit('pty-1', 0)

      expect(listener).toHaveBeenCalledOnce()
    })

    it('fires immediately for a disconnected PTY that did report an exit code', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      const pty = internals(runtime).ptysById.get('pty-1')!
      pty.connected = false
      pty.lastExitCode = 0
      const listener = vi.fn()

      runtime.subscribeToPtyExit('pty-1', listener)

      expect(listener).toHaveBeenCalledOnce()
    })
  })

  const TARGET_LOOKUP_ERROR = new Error('identity_lookup_override')

  class IdentityRuntime extends OrcaRuntimeService {
    readonly identityCalls: [string, number][] = []

    override createPreAllocatedTerminalHandle(): string {
      this.identityCalls.push(['allocate', arguments.length])
      return 'term_identity_fixture'
    }

    protected override invalidatePtyIncarnationHandle(_ptyId: string): void {
      this.identityCalls.push(['invalidate', arguments.length])
    }

    protected override getLeavesForPty(_ptyId: string) {
      this.identityCalls.push(['leaves', arguments.length])
      return []
    }

    protected override nextTitleObservationSequence(): number {
      this.identityCalls.push(['title-sequence', arguments.length])
      return 41
    }

    protected override setPtyManagementTitleFromObservedTitle(
      ...args: Parameters<OrcaRuntimeService['setPtyManagementTitleFromObservedTitle']>
    ): void {
      this.identityCalls.push(['management-title', args.length])
    }

    protected override recordPtyWorktree(
      ...args: Parameters<OrcaRuntimeService['recordPtyWorktree']>
    ) {
      this.identityCalls.push(['record', args.length])
      return super.recordPtyWorktree(...args)
    }

    protected override getLivePtyForHandle(_handle: string): never {
      this.identityCalls.push(['target', arguments.length])
      throw TARGET_LOOKUP_ERROR
    }

    recordTitle(ptyId: string, worktreeId: string) {
      return this.recordPtyWorktree(ptyId, worktreeId, { title: 'Observed title' })
    }

    resolveRecordedPty(ptyId: string) {
      return this.getOrCreatePtyWorktreeRecord(ptyId)
    }

    assertTarget(handle: string, ptyId: string): void {
      this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
    }
  }

  describe('terminal identity uses runtime overrides', () => {
    it('reserves the overridden handle and reuses it', () => {
      const runtime = new IdentityRuntime()

      expect(runtime.preAllocateHandleForPty('pty-1')).toBe('term_identity_fixture')
      expect(runtime.preAllocateHandleForPty('pty-1')).toBe('term_identity_fixture')
      expect(runtime.identityCalls).toEqual([['allocate', 0]])
    })

    it('registers through runtime invalidation and leaf lookup', () => {
      const runtime = new IdentityRuntime()

      runtime.registerPreAllocatedHandleForPty('pty-1', 'term_registered')

      expect(runtime.identityCalls).toEqual([
        ['invalidate', 1],
        ['leaves', 1]
      ])
    })

    it('records an observed title through runtime title callbacks', () => {
      const runtime = new IdentityRuntime()
      const pty = runtime.recordTitle('pty-1', 'repo::/worktree')

      expect(pty.titleUpdatedAt).toBe(41)
      expect(runtime.identityCalls).toEqual([
        ['record', 3],
        ['title-sequence', 0],
        ['management-title', 3]
      ])
    })

    it('infers a worktree through the runtime record method with two arguments', () => {
      const runtime = new IdentityRuntime()
      const pty = runtime.resolveRecordedPty('repo::/worktree@@pty-1')

      expect(pty?.worktreeId).toBe('repo::/worktree')
      expect(runtime.identityCalls).toEqual([['record', 2]])
    })

    it('preserves the overridden target lookup error', () => {
      const runtime = new IdentityRuntime()

      expect(() => runtime.assertTarget('term_target', 'pty-1')).toThrow(TARGET_LOOKUP_ERROR)
      expect(runtime.identityCalls).toEqual([['target', 1]])
    })
  })
}
