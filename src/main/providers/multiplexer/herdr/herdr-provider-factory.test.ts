import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Store } from '../../../persistence'
import type { HerdrHostTransport } from './herdr-runtime-contract'
import { HerdrSocketTransport } from './herdr-socket-transport'
import { createLocalHerdrPtyProvider } from './herdr-provider-factory'

function makeStore(settings: ReturnType<typeof getDefaultSettings>): Store {
  return { getSettings: () => settings } as unknown as Store
}

type TestSettings = ReturnType<typeof getDefaultSettings>

function localTransport(settings: TestSettings): HerdrHostTransport {
  const provider = createLocalHerdrPtyProvider(undefined, makeStore(settings))
  const transportForTarget = (
    provider as unknown as {
      transportForTarget(target: { identity: { hostId: string } }): HerdrHostTransport
    }
  ).transportForTarget
  return transportForTarget({ identity: { hostId: 'local' } })
}

describe('createLocalHerdrPtyProvider stock routing', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    delete process.env.HERDR_TEST_LEAK
  })

  it('routes the herdr backend to the stock socket transport by default', () => {
    const settings: TestSettings = {
      ...getDefaultSettings('/tmp'),
      terminalBackendDefault: 'herdr'
    }
    expect(localTransport(settings)).toBeInstanceOf(HerdrSocketTransport)
  })

  it('routes the herdr backend to the stock socket transport when the runtime is stock', () => {
    const settings: TestSettings = {
      ...getDefaultSettings('/tmp'),
      terminalBackendDefault: 'herdr',
      herdrSessionName: 'shared-name'
    }
    const transport = localTransport(settings)
    expect(transport).toBeInstanceOf(HerdrSocketTransport)

    const options = (
      transport as unknown as {
        options: {
          sessionName: string
          serverCommandFor(sessionName: string): {
            file: string
            args: string[]
            env: NodeJS.ProcessEnv
          }
        }
      }
    ).options
    expect(options.sessionName).toBe('shared-name')

    process.env.HERDR_TEST_LEAK = 'must-be-stripped'
    const serverCommand = options.serverCommandFor('mysession')
    expect(serverCommand.file).toBe('herdr')
    expect(serverCommand.args).toEqual(['--session', 'mysession', 'server'])
    expect(serverCommand.env.HERDR_TEST_LEAK).toBeUndefined()
    expect(serverCommand.env.HERDR_SESSION).toBeUndefined()
  })

  it('falls back to the stock socket transport for a non-herdr backend', () => {
    const settings: TestSettings = { ...getDefaultSettings('/tmp') }
    expect(localTransport(settings)).toBeInstanceOf(HerdrSocketTransport)
  })
})
