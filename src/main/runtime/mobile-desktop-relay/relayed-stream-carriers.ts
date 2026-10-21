/**
 * How each streaming method a phone can relay names its stream. `terminal-stream-id`: the host
 * allocates ids in `result.streamId` and terminal binary headers, renumbered by RelayedPhoneReplies.
 * `none`: replies carry no host-allocated id (the phone holds one screencast at a time).
 * `phone-binary-frames`: the client drives the stream with binary frames, which the relay never
 * forwards, so the call is refused rather than opened dead. The census test fails on a new stream.
 */
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
