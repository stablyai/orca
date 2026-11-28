import { expect, it } from 'vitest'
import { PiRpcSessionStartup } from './rpc-session-startup'

it('publishes the extension catalog while the model listing is pending', async () => {
  const listing = Promise.withResolvers<{ models: [] }>()
  const connection = {
    closed: false,
    request: (command: string) => {
      switch (command) {
        case 'get_available_models':
          return listing.promise
        case 'get_commands':
          return Promise.resolve({ commands: [{ name: 'goal', source: 'extension' }] })
        case 'get_state':
          return Promise.resolve({})
        default:
          return Promise.reject(new Error(`Unexpected RPC command: ${command}`))
      }
    }
  }
  const startup = new PiRpcSessionStartup(
    {
      identity: {
        sessionId: 'pi-command-fixture',
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'pi',
        providerHandle: null
      },
      fence: 1,
      spawnToken: 'fixture'
    },
    connection,
    {
      logger: { warn: () => {}, error: () => {} },
      onLifecycle: () => {},
      onSettled: () => {},
      persistResumePoint: async () => {}
    },
    false,
    () => {},
    () => undefined,
    new Promise<never>(() => {}),
    () => () => true
  )
  try {
    startup.reportAfterOpen('fixture', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(startup.commands).toEqual([{ name: 'goal', kind: 'command' }])
  } finally {
    listing.resolve({ models: [] })
  }
})
