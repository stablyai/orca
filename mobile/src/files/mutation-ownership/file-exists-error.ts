import '../../i18n/mobile-i18n'

export function isFileExistsErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('eexist') || normalized.includes('already exists')
}
