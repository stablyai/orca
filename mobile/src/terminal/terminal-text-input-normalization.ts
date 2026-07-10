// Why: iOS smart punctuation can rewrite two ASCII hyphens into a single
// Unicode dash before React Native delivers terminal text input. Each dash maps
// to exactly "--": recovering longer runs (#5222) needed the previous controlled
// value written back into the field, and that write-back kills iOS dictation (#7925).
const IOS_SMART_DASH_REPLACEMENT_PATTERN = /[\u2013\u2014]/g

export function normalizeTerminalTextInput(text: string): string {
  return text.replace(IOS_SMART_DASH_REPLACEMENT_PATTERN, '--')
}
