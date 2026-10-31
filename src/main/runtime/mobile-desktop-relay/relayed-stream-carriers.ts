/** terminal-stream-id renumbers result/header ids; untagged-binary sends binary frames that carry no id
 * (one phone screencast at a time); none sends no binary.
 * client-stream-ids keeps ids as sent: the client allocates them, and its binary input is forwarded unread. */
export type RelayedStreamCarrier =
  | 'terminal-stream-id'
  | 'untagged-binary'
  | 'none'
  | 'client-stream-ids'

export const RELAYED_STREAM_CARRIERS: ReadonlyMap<string, RelayedStreamCarrier> = new Map([
  ['terminal.subscribe', 'terminal-stream-id'],
  ['terminal.multiplex', 'client-stream-ids'],
  ['browser.screencast', 'untagged-binary'],
  ['agentSession.subscribe', 'none'],
  ['agentSession.subscribeStatus', 'none'],
  ['nativeChat.subscribe', 'none'],
  ['session.tabs.subscribe', 'none'],
  ['session.tabs.subscribeAll', 'none']
])
