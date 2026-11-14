import {
  joinedTerminalOrigins,
  terminalSupportQuery,
  type TerminalContentOrigin
} from '../../../../shared/terminal/output/terminal-content-origin'
import { FreebuffScreenStatusTracker } from '../../../../shared/freebuff-screen-status'
import { recognizeAgentProcessFromCommandLine } from '../../../../shared/agent-status/process/agent-process-recognition'
import type { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'

const trackers = new WeakMap<HeadlessEmulator, FreebuffScreenStatusTracker>()

export function observeFreebuffTerminalStatus(
  emulator: HeadlessEmulator,
  data: string,
  startupCommand: string | undefined,
  launchAgent?: string | null,
  scope?: TerminalContentOrigin
) {
  let tracker = trackers.get(emulator)
  if (!tracker) {
    const identified =
      launchAgent === 'freebuff' ||
      recognizeAgentProcessFromCommandLine(startupCommand)?.agent === 'freebuff'
    tracker = new FreebuffScreenStatusTracker(identified)
    trackers.set(emulator, tracker)
  }
  return tracker.observe(data, () => {
    const lines = scope ? emulator.getVisibleActionLines(scope) : emulator.getVisibleLines()
    const joined = joinedTerminalOrigins(lines)
    return {
      lines,
      alternate: emulator.isAlternateScreen,
      support: terminalSupportQuery(joined.origins, scope)
    }
  })
}
