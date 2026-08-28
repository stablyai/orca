import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { ControlPlaneStore } from '../orchestration/control-plane/control-plane-store'
import { acquireValidationLease } from '../orchestration/control-plane/validation-lease'
import { validationScopeKeyForWorktree } from '../orchestration/control-plane/validation-scope'
import type { OrcaRuntimeService } from '../orca-runtime'
import { assertNotFencedByValidationLease, ValidationLeaseFenced } from './validation-lease-fence'

const WORKTREE = 'repo_a::/work/tree'

/** "Could not check" must never read as "clear".
 *
 *  The fence documented one fail-open — a runtime with no orchestration database
 *  holds no leases — but two other paths reached the same success: a database
 *  getter that THREW, and a mutating request whose exact target could not be
 *  resolved while a lease was active. Both let a mutation through on the
 *  strength of a failed lookup. */
describe('a failed fence check is not a pass', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function fenced(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    acquireValidationLease(new ControlPlaneStore(db), {
      scopeKey: validationScopeKeyForWorktree(WORKTREE),
      leaseId: 'lease_1',
      owner: 'ctx_gate',
      idempotencyKey: 'idem_1',
      nowMs: Date.now()
    })
    return db
  }

  function runtime(overrides: Partial<Record<string, unknown>>): OrcaRuntimeService {
    return {
      getOrchestrationDb: () => db,
      showManagedTerminalWorkspace: async () => ({ id: WORKTREE }),
      showTerminal: async () => ({ worktreeId: WORKTREE }),
      ...overrides
    } as unknown as OrcaRuntimeService
  }

  it('NEGATIVE CONTROL: a database lookup that throws is refused, not waved through', async () => {
    db = new OrchestrationDb(':memory:')
    await expect(
      assertNotFencedByValidationLease(
        runtime({
          getOrchestrationDb: () => {
            throw new Error('state unreadable')
          }
        }),
        'git.commit',
        { worktree: WORKTREE }
      )
    ).rejects.toBeInstanceOf(ValidationLeaseFenced)
  })

  it('a runtime with no orchestration surface at all holds no leases', async () => {
    db = new OrchestrationDb(':memory:')
    const bare = { showManagedTerminalWorkspace: async () => ({ id: WORKTREE }) }
    await expect(
      assertNotFencedByValidationLease(bare as unknown as OrcaRuntimeService, 'git.commit', {
        worktree: WORKTREE
      })
    ).resolves.toBeUndefined()
  })

  it('a PROVEN absent database is still a legitimate fail-open', async () => {
    db = new OrchestrationDb(':memory:')
    await expect(
      assertNotFencedByValidationLease(runtime({ getOrchestrationDb: () => null }), 'git.commit', {
        worktree: WORKTREE
      })
    ).resolves.toBeUndefined()
  })

  it('NEGATIVE CONTROL: an unresolvable target is refused while any lease is active', async () => {
    fenced()
    // Letting this through is a bet that it lands somewhere unleased.
    await expect(
      assertNotFencedByValidationLease(
        runtime({
          showManagedTerminalWorkspace: async () => {
            throw new Error('no such workspace')
          }
        }),
        'git.commit',
        { worktree: 'something-unresolvable' }
      )
    ).rejects.toThrow(/cannot resolve which worktree/)
  })

  it('NEGATIVE CONTROL: a mutating call naming no target at all is refused while leased', async () => {
    fenced()
    await expect(
      assertNotFencedByValidationLease(runtime({}), 'files.write', { path: '/somewhere' })
    ).rejects.toThrow(/cannot resolve which worktree/)
  })

  it('lets an unresolvable target through when NO lease is active', async () => {
    db = new OrchestrationDb(':memory:')
    // Nothing is being protected, so the handler should report its own error
    // rather than have the fence mask it.
    await expect(
      assertNotFencedByValidationLease(runtime({}), 'files.write', { path: '/somewhere' })
    ).resolves.toBeUndefined()
  })

  it('still fences a resolvable target inside the leased worktree', async () => {
    fenced()
    await expect(
      assertNotFencedByValidationLease(runtime({}), 'git.commit', { worktree: WORKTREE })
    ).rejects.toThrow(/would contaminate it/)
  })

  it('leaves reads alone entirely', async () => {
    fenced()
    await expect(
      assertNotFencedByValidationLease(runtime({}), 'git.status', { worktree: WORKTREE })
    ).resolves.toBeUndefined()
  })
})
