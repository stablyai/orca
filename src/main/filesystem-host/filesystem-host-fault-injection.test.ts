import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { FilesystemHostProcess } from './filesystem-host-process'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'

const fixture = fileURLToPath(
  new URL('__fixtures__/filesystem-host-hang-fixture.cjs', import.meta.url)
)

describe('filesystem host cross-platform fault injection', () => {
  it('bounds an unresponsive child and opens its failure-domain breaker', async () => {
    const supervisor = new FilesystemHostSupervisor({
      entryPath: fixture,
      maximumChildren: 2,
      breakerRecoveryDelayMs: 60_000,
      startProcess: (options) =>
        FilesystemHostProcess.start({
          ...options,
          readyTimeoutMs: 1_000,
          hardKillDelayMs: 20,
          exitDeadlineMs: 500
        })
    })
    const timer = vi.fn()
    setTimeout(timer, 10)
    const request = {
      operationId: 'hung-read',
      operation: { kind: 'read-orca-yaml' as const, path: '/stall/orca.yaml', maxBytes: 1_024 },
      executionHost: 'native' as const,
      storageClass: 'workspace' as const,
      admission: 'foreground' as const,
      deadlineMs: 40
    }

    await expect(supervisor.dispatch(request)).rejects.toMatchObject({ code: 'deadline' })
    await vi.waitFor(() => expect(timer).toHaveBeenCalled(), { timeout: 1_000 })
    await expect(
      supervisor.dispatch({ ...request, operationId: 'breaker-rejection' })
    ).rejects.toMatchObject({ code: 'breaker-open' })
    await vi.waitFor(() => expect(supervisor.health().physicalChildren).toBe(0), {
      timeout: 1_000
    })
  })
})
