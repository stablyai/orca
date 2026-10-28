import { FreebuffScreenStatusTracker } from '../../shared/freebuff-screen-status'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import type { HeadlessEmulator } from '../daemon/headless-emulator'

const trackers = new WeakMap<HeadlessEmulator, FreebuffScreenStatusTracker>()

export function observeFreebuffTerminalStatus(
  emulator: HeadlessEmulator,
  data: string,
  startupCommand: string | undefined,
  launchAgent?: string | null
) {
  let tracker = trackers.get(emulator)
  if (!tracker) {
    const identified =
      launchAgent === 'freebuff' ||
      recognizeAgentProcessFromCommandLine(startupCommand)?.agent === 'freebuff'
    tracker = new FreebuffScreenStatusTracker(identified)
    trackers.set(emulator, tracker)
  }
  return tracker.observe(data, () => ({
    lines: emulator.getVisibleLines(),
    alternate: emulator.isAlternateScreen
  }))
}
