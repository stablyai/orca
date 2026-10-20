/** Read replies are local WebView messages; a lost document must never leave a tap waiting. */
export function createTerminalPromptSuggestionReads() {
  let sequence = 0
  const pending = new Map<number, (text: string | null) => void>()
  return {
    read(post: (requestId: number) => void): Promise<string | null> {
      const requestId = ++sequence
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(null), 1_500)
        const finish = (text: string | null) => {
          clearTimeout(timer)
          pending.delete(requestId)
          resolve(text)
        }
        pending.set(requestId, finish)
        try {
          post(requestId)
        } catch {
          finish(null)
        }
      })
    },
    receive(message: Record<string, unknown>) {
      if (message.type !== 'prompt-suggestion' || typeof message.requestId !== 'number') {
        return false
      }
      pending.get(message.requestId)?.(typeof message.text === 'string' ? message.text : null)
      return true
    },
    clear() {
      for (const finish of pending.values()) {
        finish(null)
      }
    }
  }
}
