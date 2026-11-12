export type MobilePushDeliveryMode = 'full' | 'disabled'

export function readMobilePushDeliveryMode(): MobilePushDeliveryMode {
  const value = process.env.ORCA_MOBILE_PUSH_MODE?.trim().toLowerCase()
  if (!value || value === 'full') {
    return 'full'
  }
  if (value === 'disabled') {
    return 'disabled'
  }
  console.warn('[push] Invalid ORCA_MOBILE_PUSH_MODE; push delivery disabled')
  return 'disabled'
}
