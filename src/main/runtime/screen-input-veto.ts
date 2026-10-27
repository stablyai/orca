import type { TuiAgent } from '../../shared/tui-agent'
import { isOmpOverlayScreen } from './omp-terminal-readiness'

/** An agent's grid as painted on its own PTY, and whether that is the alternate screen. */
export type RuledScreen = { lines: readonly string[]; alternateScreen: boolean }

/** OMP paints idle before its setup wizard opens; screen vetoes must override title, hook and quiet evidence. */
const SCREEN_INPUT_VETOES: Partial<Record<TuiAgent, (screen: RuledScreen) => boolean>> = {
  omp: isOmpOverlayScreen
}

/** Whether the agent's live screen refuses input; null with no veto rule or no trustworthy screen. */
export function readScreenInputVeto(
  agent: TuiAgent | null | undefined,
  readScreen: () => RuledScreen | null
): boolean | null {
  const veto = agent ? SCREEN_INPUT_VETOES[agent] : undefined
  const screen = veto ? readScreen() : null
  return veto && screen ? veto(screen) : null
}
