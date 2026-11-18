import { FreebuffScreenStatusTracker } from '../../../../shared/agent-status/output/freebuff-screen-status'
import { recognizeAgentProcessFromCommandLine } from '../../../../shared/agent-status/process/agent-process-recognition'
import type { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'

const trackers = new WeakMap<HeadlessEmulator, FreebuffScreenStatusTracker>()

function trackerFor(
  emulator: HeadlessEmulator,
  startupCommand: string | undefined,
  launchAgent: string | null | undefined
): FreebuffScreenStatusTracker {
  let tracker = trackers.get(emulator)
  if (!tracker) {
    const identified =
      launchAgent === 'freebuff' ||
      recognizeAgentProcessFromCommandLine(startupCommand)?.agent === 'freebuff'
    tracker = new FreebuffScreenStatusTracker(identified)
    trackers.set(emulator, tracker)
  }
  return tracker
}

/** At a gap's place in the stream: a dropped frame end must not hold the next screen, which is read once rebuilt. */
export function resetFreebuffTerminalStatusAfterGap(
  emulator: HeadlessEmulator,
  startupCommand: string | undefined,
  launchAgent: string | null | undefined
): void {
  trackerFor(emulator, startupCommand, launchAgent).resetAfterGap()
}

export function observeFreebuffTerminalStatus(
  emulator: HeadlessEmulator,
  data: string,
  startupCommand: string | undefined,
  launchAgent?: string | null,
  screenTrusted = true
) {
  return trackerFor(emulator, startupCommand, launchAgent).observe(
    data,
    () => ({ lines: emulator.getVisibleLines(), alternate: emulator.isAlternateScreen }),
    screenTrusted
  )
}
