import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FilesystemHostProcessError } from './filesystem-host-process'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'

// A stalled credential file fails its neighbours fast rather than blocking them,
// and classification is what narrows that blast radius. Both halves are load
// bearing: unclassified paths share one lane by design.

const GROK_PATH = '/home/user/.grok/auth.json'
const KIMI_PATH = '/home/user/.kimi/auth.json'
const RECOVERY_DELAY_MS = 1_000

function readDispatch(path: string) {
  return {
    operationId: randomUUID(),
    operation: { kind: 'canonicalize-path' as const, path },
    executionHost: 'native' as const,
    storageClass: 'home' as const,
    admission: 'foreground' as const,
    deadlineMs: 100
  }
}

function supervisorStallingOn(stalledPath: string, clock: () => number) {
  return new FilesystemHostSupervisor({
    entryPath: 'unused',
    maximumChildren: 4,
    breakerRecoveryDelayMs: RECOVERY_DELAY_MS,
    now: clock,
    startProcess: async () => ({
      invoke: async (operation) => {
        const path = 'path' in operation ? operation.path : ''
        if (path === stalledPath) {
          throw new FilesystemHostProcessError('deadline', 'timed out')
        }
        return { kind: 'canonicalize-path' as const, canonicalPath: path }
      },
      retire: async () => true
    })
  })
}

describe('filesystem host breaker blast radius', () => {
  it('fails neighbours in an unclassified lane fast, then recovers them', async () => {
    let clock = 0
    const supervisor = supervisorStallingOn(GROK_PATH, () => clock)

    await expect(supervisor.dispatch(readDispatch(GROK_PATH))).rejects.toMatchObject({
      code: 'deadline'
    })

    // Same `native:unknown` lane, so the neighbour is rejected rather than run —
    // stale, but never parked behind the stalled path.
    await expect(supervisor.dispatch(readDispatch(KIMI_PATH))).rejects.toMatchObject({
      code: 'breaker-open'
    })

    clock += RECOVERY_DELAY_MS
    await expect(supervisor.dispatch(readDispatch(KIMI_PATH))).resolves.toMatchObject({
      canonicalPath: KIMI_PATH
    })
  })

  it('isolates neighbours once their mounts are classified', async () => {
    let clock = 0
    const supervisor = supervisorStallingOn(GROK_PATH, () => clock)
    supervisor.publishFailureDomain({
      executionHost: 'native',
      prefix: '/home/user/.grok',
      mountId: 'grok-mount'
    })
    supervisor.publishFailureDomain({
      executionHost: 'native',
      prefix: '/home/user/.kimi',
      mountId: 'kimi-mount'
    })

    await expect(supervisor.dispatch(readDispatch(GROK_PATH))).rejects.toMatchObject({
      code: 'deadline'
    })
    await expect(supervisor.dispatch(readDispatch(KIMI_PATH))).resolves.toMatchObject({
      canonicalPath: KIMI_PATH
    })
    await expect(supervisor.dispatch(readDispatch(GROK_PATH))).rejects.toMatchObject({
      code: 'breaker-open'
    })
  })
})
