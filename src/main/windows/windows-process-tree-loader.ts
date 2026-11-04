import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ORCAD_WINDOWS_PROCESS_TREE_FILENAME } from '../../shared/orcad-artifacts'

export type NativeProcessInfo = {
  pid: number
  ppid: number
  name: string
  commandLine?: string
  creationTimeMs?: number
}

export type WindowsProcessTreeModule = {
  ProcessDataFlag: {
    None: number
    CommandLine: number
    CreationTime?: number
  }
  /** Compiled addon capabilities; patched JS enums may sit above an older prebuilt binary. */
  supportedProcessDataFlags?: number
  getProcessCreationTime?: (pid: number) => number | undefined
  getAllProcesses: (
    callback: (processes: NativeProcessInfo[] | undefined) => void,
    flags?: number
  ) => void
}

const requireFromMain = createRequire(__filename)

/** `resolve` is optional so a test can inject a bare function for the require alone. */
export type NativeRequire = ((specifier: string) => unknown) & {
  resolve?: (specifier: string) => string
}

let requireNative: NativeRequire = requireFromMain

/** Bare relay addon has no queue; nativeReadGate must serialize it to prevent concurrent native snapshots. The npm wrapper adds its own coalescing queue. */
export type WindowsProcessTreeAddon = {
  getProcessCreationTime?: (pid: number) => number | undefined
  getProcessList: (
    callback: (processes: NativeProcessInfo[] | undefined) => void,
    flags: number
  ) => void
  supportedProcessDataFlags?: number
}

/** Raw addon flags; Memory stays off. CreationTime in this enum requests it but only supportedProcessDataFlags proves binary support. */
export const PROCESS_DATA_FLAG = { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 } as const

/** Staged beside the orcad bundle by orcad-windows-process-tree.mjs. */
const RELAY_ADDON_FILENAME = `./${ORCAD_WINDOWS_PROCESS_TREE_FILENAME}`

/** The import whose absence tells the patched binary from the published prebuilt. */
const FLAGGED_ADDON_IMPORT = 'ReadProcessMemory'

/** Reject staged addons importing ReadProcessMemory: independently deployed old binaries can load yet restore EDR-flagged PEB reads. Match the build inspector without importing its node-gyp/child_process dependencies; fall back to CIM. */
function stagedRelayAddonIsUnpatched(): boolean {
  // Missing resolver denotes a test double; production resolves the binary it just loaded.
  const addonPath = requireNative.resolve?.(RELAY_ADDON_FILENAME)
  if (!addonPath) {
    return false
  }
  try {
    return readFileSync(addonPath).includes(FLAGGED_ADDON_IMPORT)
  } catch {
    return false
  }
}

let cachedModule: WindowsProcessTreeModule | null | undefined

/** Present the bare addon through the same shape as the npm package. */
function adaptAddon(addon: WindowsProcessTreeAddon): WindowsProcessTreeModule {
  return {
    ProcessDataFlag: PROCESS_DATA_FLAG,
    supportedProcessDataFlags: addon.supportedProcessDataFlags,
    getProcessCreationTime: addon.getProcessCreationTime,
    getAllProcesses: (callback, flags) => addon.getProcessList(callback, flags ?? 0)
  }
}

/** Load the desktop npm package or staged bare relay addon. Both remain optional across platforms/older deployments; null selects CIM on Windows and remains unavailable elsewhere. */
export function loadWindowsProcessTree(): WindowsProcessTreeModule | null {
  if (cachedModule !== undefined) {
    return cachedModule
  }
  if (process.platform !== 'win32') {
    cachedModule = null
    return cachedModule
  }
  try {
    cachedModule = requireNative('@vscode/windows-process-tree') as WindowsProcessTreeModule
    return cachedModule
  } catch {
    // Relays lack the npm package; try their staged addon.
  }
  try {
    const addon = requireNative(RELAY_ADDON_FILENAME) as WindowsProcessTreeAddon
    // Reject unusable shapes so an invalid addon can fall back to CIM.
    if (typeof addon?.getProcessList !== 'function') {
      /* v8 ignore next 2 */
      cachedModule = null
      return cachedModule
    }
    if (stagedRelayAddonIsUnpatched()) {
      console.warn(
        `[windows-process-table] the addon staged beside the relay bundle still imports ` +
          `${FLAGGED_ADDON_IMPORT}, so it was built from unpatched source and reads every ` +
          'process address space. Refusing it and falling back to the CIM scan; redeploy the ' +
          'relay so the staged addon is rebuilt.'
      )
      cachedModule = null
      return cachedModule
    }
    cachedModule = adaptAddon(addon)
  } catch {
    cachedModule = null
  }
  return cachedModule
}

export function setNativeRequireForTests(resolve?: NativeRequire): void {
  requireNative = resolve ?? requireFromMain
  cachedModule = undefined
}

export function resetCachedModuleForTests(): void {
  cachedModule = undefined
}
