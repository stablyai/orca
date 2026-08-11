import {
  loadWindowsNativeRegistry,
  WINDOWS_REG_EXPAND_SZ,
  WINDOWS_REG_SZ,
  type WindowsNativeRegistryModule
} from '../windows-native-registry'

export type WindowsPathRegistryRead = {
  failed: boolean
  value: string | null
}

const MACHINE_ENVIRONMENT_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const USER_ENVIRONMENT_KEY = 'Environment'
const PATH_VALUE = 'Path'

let windowsRegistryLoader = loadWindowsNativeRegistry

function readRegistryPath(
  registry: WindowsNativeRegistryModule,
  root: number,
  key: string
): WindowsPathRegistryRead {
  try {
    const values = registry.getRegistryKey(root, key)
    if (!values || typeof values !== 'object') {
      return { failed: true, value: null }
    }
    const entry = Object.entries(values).find(
      ([name]) => name.toLowerCase() === PATH_VALUE.toLowerCase()
    )?.[1]
    if (!entry) {
      return { failed: true, value: null }
    }
    if (
      (entry.type !== WINDOWS_REG_SZ && entry.type !== WINDOWS_REG_EXPAND_SZ) ||
      typeof entry.value !== 'string'
    ) {
      return { failed: true, value: null }
    }
    return { failed: false, value: entry.value }
  } catch {
    return { failed: true, value: null }
  }
}

export function readWindowsPathRegistry(): WindowsPathRegistryRead[] {
  let registry: WindowsNativeRegistryModule
  try {
    registry = windowsRegistryLoader()
  } catch {
    return [
      { failed: true, value: null },
      { failed: true, value: null }
    ]
  }
  return [
    readRegistryPath(registry, registry.HK.LM, MACHINE_ENVIRONMENT_KEY),
    readRegistryPath(registry, registry.HK.CU, USER_ENVIRONMENT_KEY)
  ]
}

export function __setWindowsPathRegistryLoaderForTests(
  loader?: () => WindowsNativeRegistryModule
): void {
  windowsRegistryLoader = loader ?? loadWindowsNativeRegistry
}
