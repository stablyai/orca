// Shared lifecycle contract every EnvironmentProviderDriver must pass; drivers call it from their test.
import { describe, expect, it } from 'vitest'
import {
  getEphemeralVmRecipeResultConnection,
  getEphemeralVmRecipeResultProjectRoot,
  isAbsoluteRuntimePath
} from '../../shared/ephemeral-vm-recipes'
import {
  ENVIRONMENT_PROVIDER_ERROR_CODES,
  isEnvironmentProviderError,
  type EnvironmentCreateSpec,
  type EnvironmentProviderDriver,
  type EnvironmentReady
} from './environment-provider-driver'

export type EnvironmentProviderDriverContractHarness = {
  driver: EnvironmentProviderDriver
  /** Ids the backing provider still holds; destroy must leave none behind. */
  liveEnvironmentIds: () => Promise<readonly string[]>
  /** A fresh driver over the same backing provider, as after an Orca restart. */
  reopenDriver: () => EnvironmentProviderDriver
}

// Handles are persisted with the runtime record, so later calls only ever see the JSON form.
function reload<T>(handle: T): T {
  return JSON.parse(JSON.stringify(handle))
}

export function runEnvironmentProviderDriverContract(
  name: string,
  makeHarness: () => Promise<EnvironmentProviderDriverContractHarness>,
  spec: (workspaceId: string) => EnvironmentCreateSpec = (workspaceId) => ({ workspaceId })
): void {
  describe(`${name} satisfies the environment provider driver contract`, () => {
    function expectReady(driver: EnvironmentProviderDriver, ready: EnvironmentReady): void {
      expect(ready.handle.driverId).toBe(driver.id)
      expect(ready.handle.environmentId).not.toBe('')
      expect(['orca-server', 'ssh']).toContain(
        getEphemeralVmRecipeResultConnection(ready.result).type
      )
      expect(isAbsoluteRuntimePath(getEphemeralVmRecipeResultProjectRoot(ready.result))).toBe(true)
      if (driver.capabilities.maxSessionMs !== null) {
        expect(ready.session.deadlineAt).not.toBeNull()
        expect(ready.session.deadlineAt! - ready.session.startedAt).toBeLessThanOrEqual(
          driver.capabilities.maxSessionMs
        )
      }
    }

    it('creates, suspends, resumes and destroys one environment without leaking it', async () => {
      const { driver, liveEnvironmentIds, reopenDriver } = await makeHarness()
      const phases: string[] = []
      const created = await driver.create(spec('ws-contract-1'), {
        onProgress: ({ phase }) => phases.push(phase)
      })
      expectReady(driver, created)
      expect(phases.length).toBeGreaterThan(0)
      expect(await liveEnvironmentIds()).toContain(created.handle.environmentId)
      expect((await driver.status(created.handle)).status).toBe('running')

      const suspended = await driver.suspend(created.handle)
      expect(suspended.status).toBe('suspended')
      expect((await driver.status(created.handle)).status).toBe('suspended')

      const resumed = await driver.resume(created.handle)
      expectReady(driver, resumed)
      expect(resumed.handle.environmentId).toBe(created.handle.environmentId)
      expect((await driver.status(created.handle)).status).toBe('running')

      await driver.destroy(created.handle)
      expect(await liveEnvironmentIds()).not.toContain(created.handle.environmentId)
      // Idempotent: cleanup retries after a lost response or a restart must not fail.
      await reopenDriver().destroy(reload(created.handle))
    })

    it('refuses to bring back a destroyed environment, even after a restart', async () => {
      const { driver, liveEnvironmentIds, reopenDriver } = await makeHarness()
      const created = await driver.create(spec('ws-contract-2'))
      await driver.destroy(created.handle)
      const error = await reopenDriver()
        .resume(reload(created.handle))
        .then(
          () => null,
          (caught: unknown) => caught
        )
      expect(isEnvironmentProviderError(error)).toBe(true)
      expect(await liveEnvironmentIds()).not.toContain(created.handle.environmentId)
    })

    it('rejects a cancelled create with a catalogued error and leaks nothing', async () => {
      const { driver, liveEnvironmentIds } = await makeHarness()
      const controller = new AbortController()
      controller.abort()
      const error = await driver.create(spec('ws-contract-3'), { signal: controller.signal }).then(
        () => null,
        (caught: unknown) => caught
      )
      expect(isEnvironmentProviderError(error)).toBe(true)
      expect(ENVIRONMENT_PROVIDER_ERROR_CODES).toContain(
        isEnvironmentProviderError(error) ? error.code : null
      )
      expect(await liveEnvironmentIds()).toEqual([])
    })
  })
}
