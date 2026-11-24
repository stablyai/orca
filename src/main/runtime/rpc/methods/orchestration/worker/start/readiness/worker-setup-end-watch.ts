import {
  SETUP_COMPLETE_MESSAGE,
  SETUP_FAILED_MESSAGE_PREFIX,
  SETUP_WAIT_TIMEOUT_MESSAGE
} from '../../../../../../../../shared/agent-launch/startup/setup-agent-sequencing'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'

export type SetupEnd = { at: number; failed: boolean }

/** When a wait-for-setup pane's wrapper printed that Setup ended, watched from the agent's launch so
 *  later agent output can't push the line out of the pane's recent bytes. */
export type SetupEndWatch = {
  ended: () => SetupEnd | null
  /** Called once, when Setup ends (at once if it already has). */
  onEnd: (listener: (end: SetupEnd) => void) => void
  dispose: () => void
}

const SETUP_END_LINES = [
  { line: SETUP_COMPLETE_MESSAGE, failed: false },
  { line: SETUP_FAILED_MESSAGE_PREFIX, failed: true },
  { line: SETUP_WAIT_TIMEOUT_MESSAGE, failed: true }
] as const
const SETUP_END_CARRY = Math.max(...SETUP_END_LINES.map(({ line }) => line.length)) - 1

export function watchSetupEnd(
  runtime: Pick<OrcaRuntimeService, 'subscribeToTerminalData' | 'readRecentTerminalOutput'>,
  ptyId: string
): SetupEndWatch {
  let end: SetupEnd | null = null
  let listener: ((end: SetupEnd) => void) | undefined
  let carry = ''
  let unsubscribe = (): void => {}
  const scan = (chunk: string): void => {
    const window = carry + chunk
    carry = window.slice(-SETUP_END_CARRY)
    const found = end ? undefined : SETUP_END_LINES.find(({ line }) => window.includes(line))
    if (!found) {
      return
    }
    end = { at: Date.now(), failed: found.failed }
    unsubscribe()
    listener?.(end)
  }
  unsubscribe = runtime.subscribeToTerminalData(ptyId, scan)
  scan(runtime.readRecentTerminalOutput(ptyId) ?? '')
  return {
    ended: () => end,
    onEnd: (next) => {
      listener = next
      if (end) {
        next(end)
      }
    },
    dispose: () => {
      listener = undefined
      unsubscribe()
    }
  }
}
