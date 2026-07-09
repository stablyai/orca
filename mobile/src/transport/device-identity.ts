import * as Device from 'expo-device'
import { Platform } from 'react-native'

// Why: desktop Settings → Paired Devices currently shows the placeholder name
// minted at QR time ("Mobile 7/3/2026"). The phone can report a human model
// on e2ee_auth so the desktop renames the registry entry after first connect.

const MAX_DEVICE_NAME_LENGTH = 64

export function resolveMobileDeviceDisplayName(): string {
  // Why: expo-constants dropped Constants.platform.ios.model in SDK 52+; use
  // expo-device's marketing name so iOS reports "iPhone 15 Pro" instead of
  // the bare "iPhone" fallback.
  if (Platform.OS === 'ios') {
    const modelName = typeof Device.modelName === 'string' ? Device.modelName.trim() : ''
    if (modelName) {
      return sanitizeDeviceDisplayName(modelName) ?? fallbackPlatformLabel()
    }
  }

  // Why: AndroidManifest in expo-constants has no marketing model field, but
  // RN Platform.constants exposes Brand/Model on Android native builds.
  if (Platform.OS === 'android') {
    const constants = Platform.constants as {
      Brand?: string
      Model?: string
      Manufacturer?: string
    }
    const brand = typeof constants.Brand === 'string' ? constants.Brand.trim() : ''
    const model = typeof constants.Model === 'string' ? constants.Model.trim() : ''
    if (brand && model && !model.toLowerCase().startsWith(brand.toLowerCase())) {
      return sanitizeDeviceDisplayName(`${brand} ${model}`) ?? fallbackPlatformLabel()
    }
    if (model) {
      return sanitizeDeviceDisplayName(model) ?? fallbackPlatformLabel()
    }
    if (brand) {
      return sanitizeDeviceDisplayName(brand) ?? fallbackPlatformLabel()
    }
  }

  return fallbackPlatformLabel()
}

export function sanitizeDeviceDisplayName(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DEVICE_NAME_LENGTH)
  return cleaned.length > 0 ? cleaned : null
}

function fallbackPlatformLabel(): string {
  if (Platform.OS === 'ios') {
    return 'iPhone'
  }
  if (Platform.OS === 'android') {
    return 'Android'
  }
  return 'Mobile'
}
