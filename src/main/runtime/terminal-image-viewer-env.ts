import { TERMINAL_IMAGE_VIEWER_CAPABILITY } from '../../shared/terminal-image-viewer-capability'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RpcContext } from './rpc/core'

export function terminalImageViewerSupported(
  context: Pick<
    RpcContext,
    'caller' | 'clientKind' | 'clientId' | 'pairedDeviceId' | 'connectionId' | 'clientCapabilities'
  >
): boolean | undefined {
  if (context.caller?.kind === 'desktop') {
    return undefined
  }
  if (
    context.caller?.kind === 'local-cli' &&
    context.clientKind === undefined &&
    context.clientId === undefined &&
    context.pairedDeviceId === undefined &&
    context.connectionId === undefined
  ) {
    return undefined
  }
  return (
    context.caller?.kind === 'paired-device' &&
    context.clientKind === 'runtime' &&
    context.clientCapabilities?.includes(TERMINAL_IMAGE_VIEWER_CAPABILITY) === true
  )
}

export function applyClaudeTerminalImageViewerEnv<
  T extends {
    launchAgent?: TuiAgent
    env?: Record<string, string>
  }
>(launch: T, supported: boolean | undefined, agent = launch.launchAgent): T {
  if (
    supported !== false ||
    agent !== 'claude' ||
    launch.env?.CLAUDE_CODE_FORCE_TERMINAL_IMAGES !== undefined ||
    process.env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES !== undefined
  ) {
    return launch
  }
  return { ...launch, env: { ...launch.env, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '0' } }
}
