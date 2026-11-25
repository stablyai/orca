// The page asks the WebView, which reports the phone's own language list; expo-localization stays out of the page bundle.
export function onDeviceSpeechLocale(): string {
  return globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language ?? 'en-US'
}
