export type TerminalLiveAsyncSendStep = () => Promise<boolean>

export async function sendTerminalLiveControlAfterPendingFlush(
  flushPendingText: TerminalLiveAsyncSendStep,
  sendControlBytes: TerminalLiveAsyncSendStep
): Promise<boolean> {
  const flushed = await flushPendingText()
  if (!flushed) {
    return false
  }
  return sendControlBytes()
}
