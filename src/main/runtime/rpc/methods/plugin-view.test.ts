import { afterEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from '../core'
import type { PluginViewDesktop } from '../../../plugins/view/plugin-view-desktop'
import { PLUGIN_VIEW_METHODS, setPluginViewForRpc } from './plugin-view'
import { PluginOpenParams, PluginShotParams } from '../../../../shared/rpc-contract/plugins-params'

function method(name: string): RpcMethod {
  const found = eraseRpcMethods(PLUGIN_VIEW_METHODS).find((entry) => entry.name === name)
  if (!found || 'stream' in found) {
    throw new Error(`missing unary ${name}`)
  }
  return found
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers never touch the runtime.
const context: RpcContext = { runtime: {} as RpcContext['runtime'], caller: { kind: 'local-cli' } }

afterEach(() => setPluginViewForRpc(null))

describe('plugins.open / plugins.shot params', () => {
  it('takes a panel or a file, never both, and a qualified key', () => {
    expect(PluginOpenParams.safeParse({ pluginKey: 'acme.todos' }).success).toBe(true)
    expect(
      PluginOpenParams.safeParse({ pluginKey: 'acme.todos', filePath: '/w/a.notes' }).success
    ).toBe(true)
    expect(
      PluginOpenParams.safeParse({ pluginKey: 'acme.todos', panelId: 'a', filePath: '/w/a' })
        .success
    ).toBe(false)
    expect(PluginOpenParams.safeParse({ pluginKey: 'todos' }).success).toBe(false)
  })

  it('bounds the width and names the theme', () => {
    const ok = PluginShotParams.safeParse({
      pluginKey: 'acme.todos',
      colorScheme: 'light',
      width: 360
    })
    expect(ok.success).toBe(true)
    for (const bad of [
      { width: 20 },
      { width: 99_999 },
      { width: 3.5 },
      { colorScheme: 'sepia' }
    ]) {
      expect(PluginShotParams.safeParse({ pluginKey: 'acme.todos', ...bad }).success).toBe(false)
    }
  })

  it('takes an optional ifShown flag', () => {
    expect(PluginShotParams.parse({ pluginKey: 'acme.todos', ifShown: true })).toEqual({
      pluginKey: 'acme.todos',
      ifShown: true
    })
    expect(PluginShotParams.safeParse({ pluginKey: 'acme.todos', ifShown: 'yes' }).success).toBe(
      false
    )
  })

  it('ignores fields a newer client adds', () => {
    expect(PluginShotParams.safeParse({ pluginKey: 'acme.todos', futureFlag: true }).success).toBe(
      true
    )
  })
})

describe('plugins.open / plugins.shot', () => {
  it('refuse clearly on a host with no desktop window', async () => {
    await expect(
      method('plugins.open').handler({ pluginKey: 'acme.todos' }, context)
    ).rejects.toThrow(/only available in the Orca desktop app/)
    await expect(
      method('plugins.shot').handler({ pluginKey: 'acme.todos' }, context)
    ).rejects.toThrow(/only available in the Orca desktop app/)
  })

  it('hand the request to the desktop view', async () => {
    const view: PluginViewDesktop = {
      open: vi.fn().mockResolvedValue({ kind: 'panel' }),
      shot: vi.fn().mockResolvedValue({ png: 'x' })
    }
    setPluginViewForRpc(view)
    await method('plugins.open').handler({ pluginKey: 'acme.todos', panelId: 'a' }, context)
    await method('plugins.shot').handler({ pluginKey: 'acme.todos', width: 300 }, context)
    expect(view.open).toHaveBeenCalledWith({ pluginKey: 'acme.todos', panelId: 'a' })
    expect(view.shot).toHaveBeenCalledWith({ pluginKey: 'acme.todos', width: 300 })
  })

  it('need host-admin, like the other plugin controls', () => {
    expect(method('plugins.open').permission).toBe('host-admin')
    expect(method('plugins.shot').permission).toBe('host-admin')
  })
})
