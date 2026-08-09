import { describe, expect, it, vi } from 'vitest'
import { AGENT_PERMISSION_AUTO_SETTINGS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  applyAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from '../../../../shared/tui-agent-permissions'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

async function dispatchAsPairedClient(
  dispatcher: RpcDispatcher,
  method: string,
  params: unknown,
  clientCapabilities: readonly string[]
): Promise<unknown> {
  let response: unknown
  await dispatcher.dispatchStreaming(
    makeRequest(method, params),
    (value) => {
      response = JSON.parse(value)
    },
    { clientKind: 'runtime', clientCapabilities }
  )
  return response
}

function createAutoSettings() {
  return {
    defaultTuiAgent: 'codex' as const,
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    ...applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })
  }
}

describe('client UI agent permission version skew', () => {
  it('projects Auto settings as Manual for legacy paired clients', async () => {
    const settings = createAutoSettings()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => settings)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const legacyResponse = await dispatchAsPairedClient(dispatcher, 'settings.get', undefined, [])
    const currentResponse = await dispatchAsPairedClient(dispatcher, 'settings.get', undefined, [
      AGENT_PERMISSION_AUTO_SETTINGS_RUNTIME_CAPABILITY
    ])

    expect(legacyResponse).toMatchObject({
      ok: true,
      result: { settings: { agentDefaultArgs: {}, agentDefaultEnv: {} } }
    })
    expect(currentResponse).toMatchObject({
      ok: true,
      result: {
        settings: {
          agentDefaultArgs: settings.agentDefaultArgs,
          agentDefaultEnv: settings.agentDefaultEnv
        }
      }
    })
  })

  it('blocks legacy permission writes while the host owns an Auto profile', async () => {
    const settings = createAutoSettings()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => settings),
      updateClientSettings: vi.fn(() => settings)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    await dispatchAsPairedClient(
      dispatcher,
      'settings.update',
      {
        defaultTuiAgent: 'claude',
        agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      },
      []
    )

    expect(runtime.updateClientSettings).toHaveBeenCalledWith({ defaultTuiAgent: 'claude' })
  })

  it('accepts permission writes from current paired clients', async () => {
    const settings = createAutoSettings()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => settings),
      updateClientSettings: vi.fn(() => settings)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
    const updates = {
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    }

    await dispatchAsPairedClient(dispatcher, 'settings.update', updates, [
      AGENT_PERMISSION_AUTO_SETTINGS_RUNTIME_CAPABILITY
    ])

    expect(runtime.updateClientSettings).toHaveBeenCalledWith(updates)
  })

  it('accepts legacy permission writes when the host has no Auto profile', async () => {
    const settings = {
      ...createAutoSettings(),
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => settings),
      updateClientSettings: vi.fn(() => settings)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
    const updates = {
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    }

    await dispatchAsPairedClient(dispatcher, 'settings.update', updates, [])

    expect(runtime.updateClientSettings).toHaveBeenCalledWith(updates)
  })
})
