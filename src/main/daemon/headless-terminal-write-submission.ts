import type { Terminal } from '@xterm/headless'

export function submitHeadlessTerminalWrite(
  terminal: Terminal,
  data: string,
  callbacks: {
    enterReplyWindow?: () => void
    leaveReplyWindow?: () => void
    parsed: () => void
    settled: () => void
  }
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let replyWindowOpen = false
    const finish = (failure?: { error: unknown }): void => {
      if (settled) {
        return
      }
      settled = true
      try {
        if (replyWindowOpen) {
          callbacks.leaveReplyWindow?.()
        }
        if (failure !== undefined) {
          reject(failure.error)
          return
        }
        callbacks.parsed()
        resolve()
      } catch (failure) {
        reject(failure)
      } finally {
        callbacks.settled()
      }
    }
    try {
      if (callbacks.enterReplyWindow) {
        terminal.write('', () => {
          if (settled) {
            return
          }
          replyWindowOpen = true
          callbacks.enterReplyWindow?.()
        })
      }
      terminal.write(data, () => finish())
    } catch (error) {
      finish({ error })
    }
  })
}
