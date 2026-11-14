import type {
  ComputerLaunchAppResult,
  ComputerListAppsResult,
  ComputerProviderCapabilities
} from '../../../shared/computer-use-runtime-types'
import { RuntimeClientError } from '../runtime-client-error'
import { stringParam } from './desktop-script-provider-params'
import type { BridgeRequest, BridgeResponse } from './desktop-script-provider-types'
import { normalizeBridgeApp } from './snapshots/desktop-script-snapshot-rendering'

type CallBridge = (request: BridgeRequest) => Promise<BridgeResponse>

export async function listBridgeApps(callBridge: CallBridge): Promise<ComputerListAppsResult> {
  const response = await callBridge({ tool: 'list_apps' })
  return {
    apps: (response.apps ?? []).map((app) => ({
      name: app.name,
      bundleId: app.bundleId ?? app.bundleIdentifier ?? null,
      pid: app.pid,
      isRunning: true,
      lastUsedAt: null,
      useCount: null
    }))
  }
}

export async function launchBridgeApp(
  capabilities: ComputerProviderCapabilities,
  callBridge: CallBridge,
  params: Record<string, unknown>
): Promise<ComputerLaunchAppResult> {
  if (capabilities.supports.apps.launch !== true) {
    throw new RuntimeClientError(
      'unsupported_capability',
      `${capabilities.provider} does not support apps.launch`
    )
  }
  const response = await callBridge({
    tool: 'launch_app',
    app: stringParam(params, 'app'),
    activate: params.activate === true
  })
  return {
    app: normalizeBridgeApp(response.app),
    launched: response.launched === true,
    delivery: response.delivery === 'foreground' ? 'foreground' : 'background'
  }
}
