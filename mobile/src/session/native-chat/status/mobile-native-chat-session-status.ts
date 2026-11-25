export type MobileNativeChatStatus =
  | 'idle'
  | 'loading'
  | 'waiting-session'
  // No transcript file yet: render the empty chat while keeping its read unsettled.
  | 'awaiting-transcript'
  | 'ready'
  | 'error'
