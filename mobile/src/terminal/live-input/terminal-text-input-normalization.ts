// Map iOS smart dashes to --; repairing longer runs via controlled write-back would interrupt dictation.
const IOS_SMART_DASH_REPLACEMENT_PATTERN = /[\u2013\u2014]/g

export function normalizeTerminalTextInput(text: string): string {
  return text.replace(IOS_SMART_DASH_REPLACEMENT_PATTERN, '--')
}
