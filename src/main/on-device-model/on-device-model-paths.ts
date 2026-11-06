import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Absolute path to the Foundation Models helper, or null when this build/os has none. */
export function resolveOnDeviceModelHelperPath(): string | null {
  const override = process.env.ORCA_ON_DEVICE_MODEL_PATH
  if (override && existsSync(override)) {
    return override
  }

  // macOS 26 aborts helpers launched from Resources, so packaged builds ship it beside the app binary.
  const candidates = [
    ...(process.resourcesPath ? [join(process.resourcesPath, '..', 'MacOS', HELPER_NAME)] : []),
    join(process.cwd(), 'native/on-device-model-macos/.build/release', HELPER_NAME),
    resolve(__dirname, '../../../native/on-device-model-macos/.build/release', HELPER_NAME)
  ]

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

const HELPER_NAME = 'orca-on-device-model'
