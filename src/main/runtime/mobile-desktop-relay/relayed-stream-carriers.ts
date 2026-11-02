/** terminal-stream-id renumbers result/header ids; none carries no id (one phone screencast at a time).
 * Refuse phone-binary-frames because the relay cannot forward their input. */
export type RelayedStreamCarrier = 'terminal-stream-id' | 'none' | 'phone-binary-frames'

export const RELAYED_STREAM_CARRIERS: ReadonlyMap<string, RelayedStreamCarrier> = new Map([
  ['terminal.subscribe', 'terminal-stream-id'],
  ['terminal.multiplex', 'phone-binary-frames'],
  ['browser.screencast', 'none'],
  ['agentSession.subscribe', 'none'],
  ['agentSession.subscribeStatus', 'none'],
  ['nativeChat.subscribe', 'none'],
  ['session.tabs.subscribe', 'none'],
  ['session.tabs.subscribeAll', 'none']
])
