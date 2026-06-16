// Why: iOS smart punctuation can rewrite two ASCII hyphens into a single
// Unicode dash before React Native delivers terminal text input.
const IOS_SMART_DASH_REPLACEMENT_PATTERN = /[\u2013\u2014]/g
const IOS_SMART_DASH_REPLACEMENT_TEST = /[\u2013\u2014]/

export function normalizeTerminalTextInput(text: string, previousText = ''): string {
  const normalizedText = text.replace(IOS_SMART_DASH_REPLACEMENT_PATTERN, '--')
  const previousTrailingHyphens = /-+$/.exec(previousText)?.[0] ?? ''
  const previousPrefix = previousText.slice(0, previousText.length - previousTrailingHyphens.length)
  const collapsedPreviousHyphenRun =
    previousTrailingHyphens.length >= 2 &&
    IOS_SMART_DASH_REPLACEMENT_TEST.test(text) &&
    (text === `${previousPrefix}\u2013` || text === `${previousPrefix}\u2014`)
  if (collapsedPreviousHyphenRun) {
    return `${previousText}-`
  }
  return normalizedText
}
