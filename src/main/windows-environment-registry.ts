import { expandWindowsEnvironmentVariables } from '../shared/windows-environment-expansion'
import {
  loadWindowsNativeRegistry,
  WINDOWS_REG_EXPAND_SZ,
  WINDOWS_REG_SZ,
  type WindowsNativeRegistryModule
} from './windows-native-registry'

const MACHINE_ENVIRONMENT_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const USER_ENVIRONMENT_KEY = 'Environment'

let windowsRegistryLoader = loadWindowsNativeRegistry

function readNamedValue(
  registry: WindowsNativeRegistryModule,
  root: number,
  key: string,
  name: string
): string | null {
  try {
    const values = registry.getRegistryKey(root, key)
    if (!values || typeof values !== 'object') {
      return null
    }
    const entry = Object.entries(values).find(
      ([entryName]) => entryName.toLowerCase() === name.toLowerCase()
    )?.[1]
    if (
      !entry ||
      (entry.type !== WINDOWS_REG_SZ && entry.type !== WINDOWS_REG_EXPAND_SZ) ||
      typeof entry.value !== 'string'
    ) {
      return null
    }
    return entry.type === WINDOWS_REG_EXPAND_SZ
      ? expandWindowsEnvironmentVariables(entry.value, process.env)
      : entry.value
  } catch {
    return null
  }
}

// Why: packaged Windows apps inherit Explorer's snapshot; setx updates HKCU\Environment without refreshing it (#14740).
export function readWindowsRegistryEnvironmentValue(name: string): string | null {
  if (process.platform !== 'win32') {
    return null
  }
  let registry: WindowsNativeRegistryModule
  try {
    registry = windowsRegistryLoader()
  } catch {
    return null
  }
  return (
    readNamedValue(registry, registry.HK.CU, USER_ENVIRONMENT_KEY, name) ??
    readNamedValue(registry, registry.HK.LM, MACHINE_ENVIRONMENT_KEY, name)
  )
}

export function __setWindowsEnvironmentRegistryLoaderForTests(
  loader?: () => WindowsNativeRegistryModule
): void {
  windowsRegistryLoader = loader ?? loadWindowsNativeRegistry
}
