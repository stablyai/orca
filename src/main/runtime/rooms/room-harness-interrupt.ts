import type { RoomHarnessRuntime, RoomTerminalHarnessBinding } from './harness-adapter-types'

const ROOM_INTERRUPT_TIMEOUT_MS = 8_000

export async function interruptRoomHarness(
  runtime: RoomHarnessRuntime,
  binding: RoomTerminalHarnessBinding
): Promise<void> {
  if (!runtime.sendTerminal) {
    throw new Error('room_agent_control_unsupported')
  }
  const abort = new AbortController()
  const wait = () =>
    runtime.waitForTerminal(binding.terminalHandle, {
      condition: 'tui-idle',
      timeoutMs: ROOM_INTERRUPT_TIMEOUT_MS,
      signal: abort.signal
    })
  const initial = wait().catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error))
  )
  try {
    await runtime.sendTerminal(binding.terminalHandle, { text: '\x1b' })
    const outcome = await initial
    if (outcome instanceof Error) {
      throw outcome
    }
    const result = outcome.satisfied ? outcome : await wait()
    if (!result.satisfied) {
      throw new Error('room_agent_not_ready')
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'terminal_exited' || error.message === 'terminal_not_writable')
    ) {
      return
    }
    if (error instanceof Error && error.message === 'timeout') {
      throw new Error('room_agent_not_ready', { cause: error })
    }
    throw error
  } finally {
    abort.abort()
  }
}
