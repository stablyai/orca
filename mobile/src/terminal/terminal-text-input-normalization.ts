// Why: iOS smart punctuation can rewrite two ASCII hyphens into a single
// Unicode dash before React Native delivers terminal text input.
const IOS_SMART_DASH_REPLACEMENT_PATTERN = /[\u2013\u2014]/g

export function normalizeTerminalTextInput(text: string): string {
  return text.replace(IOS_SMART_DASH_REPLACEMENT_PATTERN, '--')
}
