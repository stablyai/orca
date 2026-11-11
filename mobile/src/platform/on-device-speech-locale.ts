import { readDeviceUiLocaleTags } from '../i18n/system-ui-locale'

// The phone's first language, read the same way in the shell's settings and the page, so both ask the recognizer about one locale.
export function onDeviceSpeechLocale(): string {
  return readDeviceUiLocaleTags()[0] ?? 'en-US'
}
