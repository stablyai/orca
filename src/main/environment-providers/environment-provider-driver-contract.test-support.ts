// Shared lifecycle contract every EnvironmentProviderDriver must pass; drivers call it from their test.
import { describe, expect, it } from 'vitest'
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
      expect(ready.connection.type).toBe('orca-server')
      expect(ready.connection.pairingCode).not.toBe('')
      expect(ready.connection.projectRoot.startsWith('/')).toBe(true)
      if (driver.capabilities.maxSessionMs !== null) {
        expect(ready.session.deadlineAt).not.toBeNull()
        expect(ready.session.deadlineAt! - ready.session.startedAt).toBeLessThanOrEqual(
          driver.capabilities.maxSessionMs
        )
      }
    }

    it('creates, suspends, resumes and destroys one environment without leaking it', async () => {
      const { driver, liveEnvironmentIds } = await makeHarness()
      const phases: string[] = []
      const created = await driver.create(spec('ws-contract-1'), {
        onProgress: ({ phase }) => phases.push(phase)
      })
      expectReady(driver, created)
      expect(phases.length).toBeGreaterThan(0)
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
      // Idempotent: cleanup retries after a lost response must not fail.
      await driver.destroy(created.handle)
    })

    it('refuses to resume a destroyed environment with a catalogued error', async () => {
      const { driver } = await makeHarness()
      const created = await driver.create(spec('ws-contract-2'))
      await driver.destroy(created.handle)
      const error = await driver.resume(created.handle).then(
        () => null,
        (caught: unknown) => caught
      )
      expect(isEnvironmentProviderError(error)).toBe(true)
      expect(['not_found', 'conflict']).toContain(
        isEnvironmentProviderError(error) ? error.code : null
      )
    })

    it('rejects a cancelled create with a catalogued error', async () => {
      const { driver } = await makeHarness()
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
    })

    it('keeps a capped session alive and rolls it over onto the same disk', async () => {
      const { driver } = await makeHarness()
      if (driver.capabilities.maxSessionMs === null) {
        return
      }
      expect(driver.renewLease).toBeTypeOf('function')
      expect(driver.rollover).toBeTypeOf('function')
      const created = await driver.create(spec('ws-contract-4'))
      const renewed = await driver.renewLease!(created.handle, 10 * 60_000)
      expect(renewed.status).toBe('running')
      expect(renewed.session!.leaseExpiresAt!).toBeLessThanOrEqual(renewed.session!.deadlineAt!)

      const rolled = await driver.rollover!(created.handle)
      expectReady(driver, rolled)
      expect(rolled.handle.environmentId).toBe(created.handle.environmentId)
      expect(rolled.session.startedAt).toBeGreaterThan(created.session.startedAt)
      await driver.destroy(created.handle)
    })
  })
}
