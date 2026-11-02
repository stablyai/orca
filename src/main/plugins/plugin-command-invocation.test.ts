import { describe, expect, it, vi } from 'vitest'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { invokePluginWorkerCommand } from './plugin-command-invocation'
import type { PluginWorkerController } from './workers/plugin-worker-controller'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: invocation reads only the manifest's commands and main.
const plugin = {
  pluginKey: 'acme.tasks',
  manifest: { main: 'w.mjs', contributes: { commands: [{ id: 'tasks', title: 'Tasks' }] } }
} as unknown as ValidDiscoveredPlugin

describe('a command with a start deadline', () => {
  it('runs only if the worker could start it in time', async () => {
    const invokeCommand = vi.fn(async () => 'done')
    const fake = { ensure: vi.fn(async () => ({ commands: ['tasks'], invokeCommand })) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: invocation uses only ensure's commands and invokeCommand.
    const workers = fake as unknown as Pick<PluginWorkerController, 'ensure'>
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    await expect(
      invokePluginWorkerCommand('acme.tasks', plugin, workers, 'tasks', undefined, 2_000)
    ).resolves.toBe('done')
    await expect(
      invokePluginWorkerCommand('acme.tasks', plugin, workers, 'tasks', undefined, 500)
    ).rejects.toThrow(/started too late/)
    expect(invokeCommand).toHaveBeenCalledTimes(1)
  })
})
