import { openCodeHookService } from '../opencode/hook-service'
import { mimoCodeHookService } from '../mimo/hook-service'
import { piTitlebarExtensionService } from '../pi/titlebar-extension-service'
import type { PiAgentKind } from '../../shared/pi-agent-kind'

export type OverlayKind = 'opencode' | 'mimo-code' | 'pi' | 'omp' | 'prime-agent'

export type OverlayDescriptor = {
  readonly kind: OverlayKind
  readonly materialize: (...args: never[]) => Record<string, string>
  readonly clear: (ptyId: string) => void
}

/** Single lifecycle projection for agent overlays. It delegates ownership to
 * each provider service and intentionally stores no status/reducer state. */
export class AgentOverlayRegistry {
  readonly descriptors: readonly OverlayKind[] = [
    'opencode',
    'mimo-code',
    'pi',
    'omp',
    'prime-agent'
  ]

  buildOpenCodeEnv(ptyId: string, source?: string): Record<string, string> {
    return openCodeHookService.buildPtyEnv(ptyId, source)
  }

  buildMimoCodeEnv(ptyId: string, source?: string): Record<string, string> {
    return mimoCodeHookService.buildPtyEnv(ptyId, source)
  }

  buildPiEnv(
    ptyId: string,
    source: string | undefined,
    kind: PiAgentKind,
    options: { materializeDefaultHome: boolean }
  ): Record<string, string> {
    return piTitlebarExtensionService.buildPtyEnv(ptyId, source, kind, options)
  }

  clearPty(ptyId: string): void {
    openCodeHookService.clearPty(ptyId)
    mimoCodeHookService.clearPty(ptyId)
    piTitlebarExtensionService.clearPty(ptyId)
  }
}

export const agentOverlayRegistry = new AgentOverlayRegistry()
