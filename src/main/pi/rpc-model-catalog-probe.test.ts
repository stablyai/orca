import { describe, expect, it, vi } from 'vitest'
import { createPiModelCatalogProbe, type PiModelCatalogProbeDeps } from './rpc-model-catalog-probe'
import { readPiRpcSessionOptions } from './rpc-options'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'

const INVENTORY = {
  models: [
    {
      provider: 'custom',
      id: 'family/reasoner',
      name: 'Runtime reasoner',
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' }
    },
    { provider: 'other', id: 'plain', reasoning: false }
  ]
}

const invocation = {
  resolveEnvironment: async () => ({
    PATH: '/usr/bin',
    HOME: '/home/user',
    PI_CODING_AGENT_DIR: '/homes/old',
    ORCA_PANE_KEY: 'p'
  }),
  resolveCommand: () => '/opt/pi/bin/pi',
  probeVersion: async () => ({ version: '0.84.0' }),
  homePath: '/home/user'
}
const account = { variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi-a' }

describe('Pi model catalog', () => {
  it('reads the same runtime inventory as a chat in the requested folder and awaits close', async () => {
    const request = vi.fn(async (_command: string) => INVENTORY)
    let finishClose!: () => void
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve
        })
    )
    const connect = vi.fn<NonNullable<PiModelCatalogProbeDeps['connect']>>(() => ({
      request,
      close
    }))
    const probe = createPiModelCatalogProbe({ ...invocation, connect })
    const result = probe(account, { workspacePath: '/work/project' })
    let settled = false
    void result.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    finishClose()
    const success = await result
    expect(request.mock.calls).toEqual([['get_available_models']])
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/opt/pi/bin/pi',
        args: ['--mode', 'rpc', '--no-session'],
        cwd: '/work/project',
        env: expect.objectContaining({ PI_CODING_AGENT_DIR: '/homes/pi-a' }),
        envToDelete: expect.arrayContaining(['ORCA_PANE_KEY'])
      })
    )
    const launch = connect.mock.calls[0]![0]
    expect(
      resolveProviderChildEnv(launch, { ORCA_AGENT_SESSION_ID: 'old-chat' })
    ).not.toHaveProperty('ORCA_PANE_KEY')
    expect(
      resolveProviderChildEnv(launch, { ORCA_AGENT_SESSION_ID: 'old-chat' })
    ).not.toHaveProperty('ORCA_AGENT_SESSION_ID')
    expect(success.models).toEqual([
      {
        id: 'custom/family/reasoner',
        label: 'Runtime reasoner',
        isDefault: false,
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
          value,
          label: value
        }))
      },
      { id: 'other/plain', label: 'other/plain', isDefault: false, efforts: [] }
    ])
    const live = await readPiRpcSessionOptions({
      request: async (command) =>
        command === 'get_available_models'
          ? INVENTORY
          : { sessionFile: '/sessions/current.jsonl', isStreaming: false, isCompacting: false }
    })
    expect(success).toEqual({ models: live.models, origin: 'probe' })
  })

  it('rejects an empty cold inventory and closes it', async () => {
    const request = vi.fn(async () => ({ models: [] }))
    const close = vi.fn(async () => {})
    const probe = createPiModelCatalogProbe({ ...invocation, connect: () => ({ request, close }) })
    await expect(probe(account)).rejects.toThrow('pi listed no models')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('lists nothing from a Pi that runs no structured chat', async () => {
    const connect = vi.fn()
    const probe = createPiModelCatalogProbe({
      ...invocation,
      probeVersion: async () => ({ version: '0.83.9' }),
      connect
    })
    await expect(probe(account)).rejects.toThrow(/does not run structured chats/)
    expect(connect).not.toHaveBeenCalled()
  })
})
