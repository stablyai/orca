import { describe, expect, it } from 'vitest'
import { assertPluginWorkerCommand } from './plugin-command-invocation'

type Plugin = Parameters<typeof assertPluginWorkerCommand>[0]

function pluginWith(commands: { id: string; action?: string }[]): Plugin {
  return {
    pluginKey: 'femave.claude-mods',
    manifest: { contributes: { commands } }
  } as unknown as Plugin
}

describe('assertPluginWorkerCommand', () => {
  it('accepts a declared worker command', () => {
    expect(() =>
      assertPluginWorkerCommand(pluginWith([{ id: 'mods.panel' }]), 'mods.panel')
    ).not.toThrow()
  })

  it('rejects a command the plugin did not declare', () => {
    expect(() => assertPluginWorkerCommand(pluginWith([{ id: 'mods.panel' }]), 'other')).toThrow(
      /does not contribute command other/
    )
  })

  it('rejects a built-in action alias', () => {
    expect(() =>
      assertPluginWorkerCommand(pluginWith([{ id: 'go.tasks', action: 'view.tasks' }]), 'go.tasks')
    ).toThrow(/built-in action alias/)
  })
})
