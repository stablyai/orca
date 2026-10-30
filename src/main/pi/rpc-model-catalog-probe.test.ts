import { describe, expect, it, vi } from 'vitest'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { createPiModelCatalogProbe } from './rpc-model-catalog-probe'
import { readPiRpcSessionOptions } from './rpc-options'

const AVAILABLE_MODELS = {
  models: [
    {
      provider: 'openai',
      id: 'gpt-6',
      name: 'GPT-6',
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: 'xhigh' }
    },
    { provider: 'openai', id: 'gpt-4o-mini', name: 'GPT-4o mini', reasoning: false }
  ]
}

describe('Pi model catalog', () => {
  it.each(['', `"${process.execPath}" run -- pi`])(
    'lists the native menu through sessionless RPC for Command %j',
    async (command) => {
      const launches: ProviderProcessLaunch[] = []
      const close = vi.fn(async () => undefined)
      const probeVersion = vi.fn(async () => ({ version: '0.84.0' }))
      const probe = createPiModelCatalogProbe({
        resolveEnvironment: async () => ({
          PATH: '/usr/bin',
          HOME: '/home/user',
          ORCA_PANE_KEY: 'p'
        }),
        resolveCommandSettings: () => ({ agentCmdOverrides: { pi: command } }),
        resolveCommand: () => '/opt/pi/bin/pi',
        probeVersion,
        homePath: '/home/user',
        connect: (launch) => {
          launches.push(launch)
          return {
            request: async (command) => {
              expect(command).toBe('get_available_models')
              return AVAILABLE_MODELS
            },
            close
          }
        }
      })
      const success = await probe({ variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi-a' })
      const levels = (values: string[]) => values.map((value) => ({ value, label: value }))
      expect(success.models).toEqual([
        {
          id: 'openai/gpt-6',
          label: 'GPT-6',
          isDefault: false,
          efforts: levels(['minimal', 'low', 'medium', 'high', 'xhigh'])
        },
        { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', isDefault: false, efforts: [] }
      ])
      const live = await readPiRpcSessionOptions({
        request: async (command) =>
          command === 'get_available_models'
            ? AVAILABLE_MODELS
            : { sessionFile: '/s.jsonl', isStreaming: false, isCompacting: false }
      })
      expect(success.models).toEqual(live.models)
      expect(launches).toEqual([
        expect.objectContaining({
          command: command ? process.execPath : '/opt/pi/bin/pi',
          cwd: '/home/user',
          args: [...(command ? ['run', '--', 'pi'] : []), '--mode', 'rpc', '--no-session'],
          env: expect.objectContaining({ PI_CODING_AGENT_DIR: '/homes/pi-a' }),
          // Orca's status extension stays silent in a probe that belongs to no pane.
          envToDelete: expect.arrayContaining(['ORCA_PANE_KEY'])
        })
      ])
      expect(probeVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          program: command ? process.execPath : '/opt/pi/bin/pi',
          prefixArgs: command ? ['run', '--', 'pi'] : []
        })
      )
      expect(close).toHaveBeenCalledOnce()
    }
  )

  it('falls back to the text listing when Pi cannot answer over RPC', async () => {
    const runListing = vi.fn(async () =>
      [
        'provider   model            context  max-out  thinking  images',
        'anthropic  claude-sonnet-4  200K     64K      yes       yes',
        'openai     gpt-4o-mini      128K     16K      no        yes'
      ].join('\n')
    )
    const probe = createPiModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
      resolveCommandSettings: () => ({
        agentCmdOverrides: { pi: `"${process.execPath}" run -- pi` }
      }),
      resolveCommand: () => '/opt/pi/bin/pi',
      probeVersion: async () => ({ version: '0.84.0' }),
      homePath: '/home/user',
      connect: () => ({
        request: async () => {
          throw new Error('pi exited before answering')
        },
        close: async () => undefined
      }),
      runListing
    })
    const success = await probe({ variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi-a' })
    expect(success.models.map((model) => [model.id, model.efforts.length])).toEqual([
      ['anthropic/claude-sonnet-4', 5],
      ['openai/gpt-4o-mini', 0]
    ])
    expect(runListing).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['run', '--', 'pi', '--list-models'] }),
      expect.objectContaining({ site: 'pi-model-catalog-probe' })
    )
  })

  it('does not fall back when stopped during RPC teardown', async () => {
    const stop = new AbortController()
    const runListing = vi.fn()
    const probe = createPiModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
      resolveCommand: () => '/opt/pi/bin/pi',
      probeVersion: async () => ({ version: '1.1.0' }),
      homePath: '/home/user',
      connect: () => ({
        request: async () => {
          throw new Error('RPC interrupted')
        },
        close: async () => stop.abort()
      }),
      runListing
    })
    await expect(
      probe({ variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi' }, { signal: stop.signal })
    ).rejects.toThrow()
    expect(runListing).not.toHaveBeenCalled()
  })

  it('lists nothing from a Pi that runs no structured chat', async () => {
    const connect = vi.fn()
    const probe = createPiModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
      resolveCommand: () => '/opt/pi/bin/pi',
      probeVersion: async () => ({ version: '0.83.9' }),
      connect
    })
    await expect(probe({ variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi-a' })).rejects.toThrow(
      /does not run structured chats/
    )
    expect(connect).not.toHaveBeenCalled()
  })
})
