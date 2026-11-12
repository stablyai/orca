export type MenuBarAction = 'open' | 'settings' | 'updates' | 'quit-completely' | 'quit'
export type MenuBarItem = {
  id?: MenuBarAction
  label?: string
  toolTip?: string
  enabled?: boolean
  type?: 'separator'
}
export type MenuBarQACommand =
  | { operation: 'inspect' | 'tracking' }
  | { operation: 'invoke'; action: MenuBarAction }

export type MenuBarSnapshot = {
  images: { scale: number; png: string }[]
  template: boolean
  tooltip: string
  menu: MenuBarItem[]
}

export const FRAME_LIMIT = 256 * 1024
const ACTIONS = new Set(['open', 'settings', 'updates', 'quit-completely', 'quit'])
type Message =
  | { type: 'ready' }
  | { type: 'applied' | 'pong'; id: number }
  | { type: 'action'; sequence: number; action: MenuBarAction }
  | { type: 'qa'; [key: string]: unknown }

/** Frames are bounded before parsing and actions have a closed command set. */
export class MenuBarOutput {
  private buffer = ''

  read(chunk: string): Message[] {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > FRAME_LIMIT) {
      throw new Error('Oversized menu bar output')
    }
    const messages: Message[] = []
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(this.buffer.slice(0, newline))
      this.buffer = this.buffer.slice(newline + 1)
      if (
        !message ||
        typeof message !== 'object' ||
        !(
          message.type === 'ready' ||
          message.type === 'qa' ||
          ((message.type === 'applied' || message.type === 'pong') &&
            Number.isSafeInteger(message.id) &&
            message.id > 0) ||
          (message.type === 'action' &&
            Number.isSafeInteger(message.sequence) &&
            message.sequence > 0 &&
            ACTIONS.has(message.action))
        )
      ) {
        throw new Error('Invalid menu bar output')
      }
      messages.push(message)
    }
    return messages
  }
}

/** Only the startup-gated native QA seam has an outstanding request. */
export class MenuBarQARequest {
  private reply: {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  request(send: () => void, timeout: () => void): Promise<unknown> {
    if (this.reply) {
      return Promise.reject(new Error('Menu bar QA request already pending'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(timeout, 30_000)
      timer.unref()
      this.reply = { resolve, reject, timer }
      send()
    })
  }

  resolve(value: unknown): void {
    if (!this.reply) {
      throw new Error('Unexpected menu bar QA response')
    }
    const reply = this.reply
    clearTimeout(reply.timer)
    this.reply = null
    reply.resolve(value)
  }

  reject(): void {
    if (!this.reply) {
      return
    }
    clearTimeout(this.reply.timer)
    this.reply.reject(new Error('Menu bar helper retired'))
    this.reply = null
  }
}
