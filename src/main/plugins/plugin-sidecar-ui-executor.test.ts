import { describe, expect, it } from 'vitest'
import { applySidecarFrameOnUiMachine, PluginSidecarUiExecutor } from './plugin-sidecar-ui-executor'

const setFrame = {
  pluginKey: 'chron0.discord-presence',
  channel: 'presence' as const,
  op: 'set' as const,
  payload: { details: 'Working in Orca' },
  publishedAt: 42
}

describe('PluginSidecarUiExecutor', () => {
  it('stores a set frame and refuses to claim Discord IPC', () => {
    const executor = new PluginSidecarUiExecutor()
    const result = applySidecarFrameOnUiMachine(executor, setFrame)

    expect(result).toEqual({
      applied: true,
      discordIpc: 'not-implemented',
      frame: setFrame
    })
    expect(executor.last(setFrame.pluginKey, 'presence')).toEqual(setFrame)
  })

  it('clears the stored frame without speaking Discord IPC', () => {
    const executor = new PluginSidecarUiExecutor()
    applySidecarFrameOnUiMachine(executor, setFrame)
    const cleared = applySidecarFrameOnUiMachine(executor, {
      ...setFrame,
      op: 'clear',
      payload: null,
      publishedAt: 43
    })

    expect(cleared).toEqual({
      applied: true,
      discordIpc: 'not-implemented',
      frame: null
    })
    expect(executor.last(setFrame.pluginKey, 'presence')).toBeNull()
  })
})
