// Integrator wiring (Unit 8, spec S10 integrator note #3): openTerminalTail pushes a
// terminalTail frame with terminalId '' before the real terminal is resolved (async
// terminal.list round-trip). Once resolved, patch that frame in place so
// terminal-tail-screen's `state.terminalTail.terminalId === frame.terminalId` guard passes.
import type { ScreenFrame } from '../navigation/nav-contract'
import type { HudStore } from '../state/hud-store'

export function patchTerminalTailFrameId(
  store: HudStore,
  worktreeId: string,
  terminalId: string
): void {
  store.update((s) => {
    const index = s.nav.stack.findIndex(
      (frame) =>
        frame.screen === 'terminalTail' &&
        frame.worktreeId === worktreeId &&
        frame.terminalId === ''
    )
    if (index === -1) {
      return s
    }
    const stack = [...s.nav.stack]
    const frame = stack[index] as Extract<ScreenFrame, { screen: 'terminalTail' }>
    stack[index] = { ...frame, terminalId }
    return { ...s, nav: { ...s.nav, stack } }
  })
}
