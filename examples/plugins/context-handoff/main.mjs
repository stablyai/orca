import { randomUUID } from 'node:crypto'

// A summary producer can invoke this command with { sessionId, context, cursor, fence }.
// Without a supplied summary, preserve a bounded transcript tail. No terminal input is used.
export default function activate(orca) {
  let running = false
  orca.commands.register('context-handoff', async (args = {}) => {
    if (!orca.host.has('chat.handoff')) {
      return 'This Orca build does not support context handoffs.'
    }
    if (running) {
      return 'A handoff is already being prepared.'
    }
    running = true
    try {
      if (!args || typeof args !== 'object') {
        return 'Command arguments must be an object.'
      }
      if (
        args.context !== undefined &&
        (typeof args.context !== 'string' || !args.context.trim() || args.context.length > 65536)
      ) {
        return 'The summary must contain between 1 and 65536 characters.'
      }
      const chats = await orca.host.call('chat.list')
      const sessionId = args.sessionId ?? (chats.length === 1 ? chats[0].sessionId : undefined)
      if (!sessionId || !chats.some((chat) => chat.sessionId === sessionId)) {
        return {
          message: 'Choose a local chat by passing its sessionId.',
          chats
        }
      }
      const key = `pending:${sessionId}`
      const pending = (await orca.host.call('storage.get', { key })).value
      let request = pending
      if (!request) {
        const read = await orca.host.call('chat.readContext', { sessionId })
        if (
          args.context !== undefined &&
          (!args.cursor ||
            typeof args.cursor.epoch !== 'string' ||
            !args.cursor.epoch ||
            args.cursor.epoch.length > 512 ||
            !Number.isSafeInteger(args.cursor.sequence) ||
            args.cursor.sequence < 0 ||
            !Number.isSafeInteger(args.fence) ||
            args.fence <= 0)
        ) {
          return 'A supplied summary must include the cursor and fence of the transcript it summarizes.'
        }
        request = {
          sessionId,
          operationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
          fence: args.fence ?? read.fence,
          cursor: args.cursor ?? read.cursor,
          context:
            args.context ??
            `Recent conversation (earlier history may be omitted):\n${read.transcript.slice(-48000)}`
        }
        // Persist before mutation. A lost response retries the same operation, never another clear.
        await orca.host.call('storage.set', { key, value: request })
      }
      const result = await orca.host.call('chat.handoff', request)
      if (!result.retry) {
        await orca.host.call('storage.delete', { key })
      }
      return result.completed
        ? 'Context handed off. Your next message will include the handoff and your last message.'
        : `Handoff did not run: ${result.reason ?? 'The chat is not ready.'}`
    } finally {
      running = false
    }
  })
}
