import type { WslRelayDistroState } from './wsl-hook-relay-state'

export function endpointFile(state: WslRelayDistroState | undefined): string | null {
  return state?.connectedAt ? (state.guestEndpointFilePath ?? null) : null
}
export function claudeAgentView(
  state: WslRelayDistroState | undefined
): { pluginDir: string; configDir: string } | null {
  return state?.claudeAgentViewDir && state.claudeConfigDir
    ? { pluginDir: state.claudeAgentViewDir, configDir: state.claudeConfigDir }
    : null
}
export function openCodeOverlay(
  state: WslRelayDistroState | undefined,
  agent: 'opencode' | 'opencode2'
): string | null {
  return agent === 'opencode2'
    ? (state?.opencode2OverlayDir ?? null)
    : (state?.opencodeOverlayDir ?? null)
}
export function agentPath(
  state: WslRelayDistroState | undefined,
  kind: 'pi' | 'omp'
): string | null {
  return kind === 'pi' ? (state?.piAgentDir ?? null) : (state?.ompStatusExtension ?? null)
}
