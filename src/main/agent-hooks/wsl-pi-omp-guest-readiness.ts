import {
  detectExplicitPiAgentKindFromCommand,
  isPiCompatibleAgentType,
  type PiAgentKind
} from '../../shared/pi-agent-kind'
import type { TuiAgent } from '../../shared/tui-agent'
import { wslHookRelayManager, type WslHookRelayManager } from './wsl-hook-relay-manager'

export async function awaitExplicitPiOmpGuestReadiness(args: {
  isWsl: boolean
  distro: string | null | undefined
  codexHomePath?: string | null
  launchAgent?: TuiAgent
  launchCommand?: string
  timeoutMs?: number
  manager?: Pick<
    WslHookRelayManager,
    'ensureForDistro' | 'getGuestEndpointFilePath' | 'getGuestAgentPath'
  >
}): Promise<boolean> {
  if (!args.isWsl) {
    return true
  }
  const kind: PiAgentKind | null = isPiCompatibleAgentType(args.launchAgent)
    ? args.launchAgent
    : detectExplicitPiAgentKindFromCommand(args.launchCommand)
  if (kind !== 'pi' && kind !== 'omp') {
    return true
  }
  const distro = args.distro ?? null
  const manager = args.manager ?? wslHookRelayManager
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      manager
        .ensureForDistro(distro, args.codexHomePath, kind)
        .then(() =>
          Boolean(
            manager.getGuestEndpointFilePath(distro) && manager.getGuestAgentPath(distro, kind)
          )
        ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), args.timeoutMs ?? 10_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
