import { expect, it } from 'vitest'
import {
  usageLimitAccountSources,
  type UsageLimitAccountSourceDeps
} from './usage-limit-account-usage'

type Service = NonNullable<ReturnType<UsageLimitAccountSourceDeps['rateLimits']>>

function sources(service: () => Service | null) {
  const settings = {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the witness reads only the settings' identity
  const accountSettings = settings as unknown as ReturnType<UsageLimitAccountSourceDeps['settings']>
  return usageLimitAccountSources({
    rateLimits: service,
    settings: () => accountSettings,
    shellEnvironment: async () => ({}),
    shellEnvironmentRevision: () => 1,
    claudeLaunchEnv: () => ({}),
    processEnvironment: {}
  })
}

const noReadingYet: Service = {
  usageReadingAccount: () => null,
  usageReading: () => null,
  requestUsageReading: () => true
}

it('changes the witness when the usage service starts, before its first reading', async () => {
  let service: Service | null = null
  const { accountWitness, accountUsage } = sources(() => service)
  const home = { variable: 'CODEX_HOME', path: '/homes/next' }
  const absent = accountWitness('codex')
  expect(await accountUsage('codex', home)).toBeUndefined()

  service = noReadingYet
  // An attribution made while the service was absent no longer holds, so the next pass finds the
  // scope that can ask for a first reading.
  expect(accountWitness('codex')).not.toBe(absent)
  expect((await accountUsage('codex', home))?.bootstrap).toBeTypeOf('function')
  // Nothing else moved: the witness stays put, so the chat is not attributed on every pass.
  expect(accountWitness('codex')).toBe(accountWitness('codex'))
})
