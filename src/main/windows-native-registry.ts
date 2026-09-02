import { createRequire } from 'node:module'

export type WindowsNativeRegistryValue = {
  name?: unknown
  type?: unknown
  value?: unknown
}

export type WindowsNativeRegistryModule = {
  HK: { CU: number; LM: number }
  getRegistryKey: (
    root: number,
    path: string
  ) => Record<string, WindowsNativeRegistryValue | undefined> | null | undefined
}

export const WINDOWS_REG_SZ = 1
export const WINDOWS_REG_EXPAND_SZ = 2

const requireFromMain = createRequire(__filename)

export function loadWindowsNativeRegistry(): WindowsNativeRegistryModule {
  // Why: non-Windows installs omit this optional dependency, so never resolve it at module load.
  return requireFromMain('windows-native-registry') as WindowsNativeRegistryModule
}
