import { describe, expect, it, vi } from 'vitest'
import { AGENT_PERMISSION_AUTO_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  applyAgentPermissionMode,
  AUTO_TUI_AGENT_ARGS,
  AUTO_TUI_AGENT_ENV
} from '../../../../shared/tui-agent-permissions'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

function setup(mode: 'auto' | 'manual' = 'auto') {
  const settings = { ...applyAgentPermissionMode({ mode }), compactWorktreeCards: false }
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: vi.fn(() => settings),
    updateClientSettings: vi.fn(async (updates) => Object.assign(settings, updates)),
    updateClientPRBotAuthorOverride: vi.fn(() => settings)
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
  const request = (method: string, params?: unknown, capabilities: string[] = []) =>
    dispatcher.dispatch(
      { id: '1', authToken: 'token', method, params },
      { clientKind: 'runtime', clientCapabilities: capabilities }
    )
  return { settings, runtime, request }
}

function resultSettings(response: Awaited<ReturnType<ReturnType<typeof setup>['request']>>) {
  expect(response.ok).toBe(true)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return (response.result as { settings: ReturnType<typeof setup>['settings'] }).settings
}

describe('Auto permissions across remote versions', () => {
  it('advertises Auto support on remote request transports', () => {
    expect(remoteRuntimeClientCapabilities()).toContain(AGENT_PERMISSION_AUTO_RUNTIME_CAPABILITY)
  })

  it('projects Auto as manual to old clients without changing host settings', async () => {
    const { settings, request } = setup()
    const before = structuredClone(settings)
    const projected = resultSettings(await request('settings.get'))
    for (const agent of Object.keys(AUTO_TUI_AGENT_ARGS)) {
      expect(projected.agentDefaultArgs[agent as TuiAgent]).toBe('')
    }
    for (const agent of Object.keys(AUTO_TUI_AGENT_ENV)) {
      expect(projected.agentDefaultEnv[agent as TuiAgent]).toEqual({})
    }
    expect(settings).toEqual(before)
  })

  it('preserves Auto when an old client echoes its projection with an unrelated edit', async () => {
    const { settings, runtime, request } = setup()
    const before = structuredClone(settings)
    const projected = resultSettings(await request('settings.get'))
    const updated = resultSettings(
      await request('settings.update', { ...projected, compactWorktreeCards: true })
    )
    expect(runtime.updateClientSettings).toHaveBeenCalledWith({ compactWorktreeCards: true })
    expect(settings.agentDefaultArgs).toEqual(before.agentDefaultArgs)
    expect(settings.agentDefaultEnv).toEqual(before.agentDefaultEnv)
    expect(updated).toEqual({ ...projected, compactWorktreeCards: true })
  })

  it('rejects old-client permission widening, including unsupported Auto fallback agents', async () => {
    const { settings, runtime, request } = setup()
    const before = structuredClone(settings)
    const projected = resultSettings(await request('settings.get'))
    const response = await request('settings.update', {
      ...applyAgentPermissionMode({ ...projected, mode: 'yolo' })
    })
    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Update this Orca client') }
    })
    expect(runtime.updateClientSettings).not.toHaveBeenCalled()
    expect(settings).toEqual(before)
  })

  it('allows a capable client to view and change Auto', async () => {
    const { settings, request } = setup()
    const capabilities = [AGENT_PERMISSION_AUTO_RUNTIME_CAPABILITY]
    expect(resultSettings(await request('settings.get', undefined, capabilities))).toEqual(settings)
    const manual = applyAgentPermissionMode({ mode: 'manual' })
    expect(resultSettings(await request('settings.update', manual, capabilities))).toMatchObject(
      manual
    )
  })

  it('keeps permission edits available to legacy clients on hosts without Auto', async () => {
    const { request } = setup('manual')
    const bypass = applyAgentPermissionMode({ mode: 'yolo' })
    expect(resultSettings(await request('settings.update', bypass))).toMatchObject(bypass)
  })

  it('projects settings published by unrelated bot-author updates too', async () => {
    const { request } = setup()
    const projected = resultSettings(await request('settings.get'))
    expect(
      resultSettings(
        await request('settings.updatePRBotAuthorOverride', { author: 'bot', isBot: true })
      )
    ).toEqual(projected)
  })
})
