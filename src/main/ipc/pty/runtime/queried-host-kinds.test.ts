import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { sshProviders } from '../provider/registry'
import { listProcessesWithHostScopeFromRuntimeController } from './inventory-operations'
import type { PtyRuntimeControllerDeps } from './controller-deps'

/**
 * `hostScopeCensusIsComplete` discounts a `runtime:` host in `omittedHostIds` on the strength of
 * one fact about this process: it has no paired-runtime PTY provider, so it never queried that
 * host and never owed it coverage. This file pins the producer side of that fact.
 *
 * What it catches: a new branch here that spells a queried host `runtime:`. Every id this
 * function emits is built by `toSshExecutionHostId` or is `LOCAL_EXECUTION_HOST_ID`, so a third
 * shape is the observable form of "a runtime host can now answer an inventory" — at which point
 * the client predicate would start calling a genuine gap complete.
 *
 * What it does NOT catch, so do not lean on it: a runtime-backed transport registered under an
 * SSH connection id still reports as `ssh:` and passes, which is fine — the predicate only
 * discounts the `runtime:` spelling. The consolidation moving the SSH path onto orcad is expected
 * to look exactly like that. The other route into `queriedHostIds` is separately fenced to
 * `kind === 'ssh'` in `orca-runtime-refresh-pty-worktree-records-with-controller-inventory.ts`.
 */
describe('the hosts a PTY inventory can report having queried', () => {
  afterEach(() => {
    sshProviders.clear()
  })

  it('emits only local and ssh spellings, never a paired-runtime one', async () => {
    const listProcesses = vi.fn(async () => [])
    sshProviders.set('box-1', { listProcesses } as never)
    // A connection id shaped like an environment uuid still has to come back `ssh:`; the spelling
    // is what the gate keys on, so a `runtime:` id appearing here is the breakage that matters.
    sshProviders.set('a2478221-1d5c-4603-b8bf-b6b728eac9df', { listProcesses } as never)

    const { hostIds } = await listProcessesWithHostScopeFromRuntimeController({
      runtime: null
    } as unknown as PtyRuntimeControllerDeps)

    expect(hostIds).toContain('ssh:a2478221-1d5c-4603-b8bf-b6b728eac9df')
    expect(new Set(hostIds.map((hostId) => parseExecutionHostId(hostId)?.kind))).toEqual(
      new Set(['local', 'ssh'])
    )
  })

  it('drops a provider that threw rather than reporting its host as queried', async () => {
    sshProviders.set('box-live', { listProcesses: vi.fn(async () => []) } as never)
    sshProviders.set('box-down', {
      listProcesses: vi.fn(async () => {
        throw new Error('relay unavailable')
      })
    } as never)

    const { hostIds } = await listProcessesWithHostScopeFromRuntimeController({
      runtime: { markPtyLivenessUnverifiable: vi.fn() }
    } as unknown as PtyRuntimeControllerDeps)

    expect(hostIds).toContain('ssh:box-live')
    expect(hostIds).not.toContain('ssh:box-down')
  })
})
