import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

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
  getAllProcesses: (
    callback: (processes: NativeProcessInfo[] | undefined) => void,
    flags?: number
  ) => void
}

/** `resolve` is optional so a test can inject a bare function for the require alone. */
export type NativeRequire = ((specifier: string) => unknown) & {
  resolve?: (specifier: string) => string
}

/**
 * Mirrors the package's enum; the addon takes the raw bit field. `Memory` (1)
 * is deliberately never set by the process-table projections.
 */
export const PROCESS_DATA_FLAG = { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 } as const

/** Staged beside the relay bundle by build-relay; see RELAY_ARTIFACTS. */
const RELAY_ADDON_FILENAME = './windows-process-tree.node'

/** The import whose absence tells the patched binary from the published prebuilt. */
const FLAGGED_ADDON_IMPORT = 'ReadProcessMemory'

const requireFromMain = createRequire(__filename)

// Why injectable: `createRequire` bypasses the module mocker, and the two
// resolution steps below are the exact thing #15749 shipped untested.
let requireNative: NativeRequire = requireFromMain
let cachedModule: WindowsProcessTreeModule | null | undefined

/**
 * The bare addon a relay host receives, with no npm package around it.
 *
 * The published package's `lib/index.js` adds only a queue over this call. The
 * table reader holds the mutual exclusion instead, because this addon has no
 * queue of its own and simultaneous `CreateToolhelp32Snapshot` calls are the
 * crash the vendor's queue exists to prevent.
 */
type WindowsProcessTreeAddon = {
  getProcessList: (
    callback: (processes: NativeProcessInfo[] | undefined) => void,
    flags: number
  ) => void
}

function isWindowsProcessTreeModule(value: unknown): value is WindowsProcessTreeModule {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as {
    ProcessDataFlag?: unknown
    getAllProcesses?: unknown
  }
  if (typeof candidate.getAllProcesses !== 'function') {
    return false
  }
  if (typeof candidate.ProcessDataFlag !== 'object' || candidate.ProcessDataFlag === null) {
    return false
  }
  const flags = candidate.ProcessDataFlag as { None?: unknown; CommandLine?: unknown }
  return typeof flags.None === 'number' && typeof flags.CommandLine === 'number'
}

/**
 * Refuse a staged relay addon built from unpatched source.
 *
 * The build asserts this on the artifact it produces, but a relay bundle and the
 * addon beside it are redeployed independently. A host that has not taken a new
 * bundle keeps whatever `.node` is already there, and the published prebuilt
 * binds cleanly before opening every process with `PROCESS_VM_READ`. Falling
 * back to the CIM scan is the correct loss: slower, but not the thing an EDR
 * quarantines the host for.
 */
function stagedRelayAddonIsUnpatched(): boolean {
  // No resolver means an injected test double, so there is no file to inspect.
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

/** Present the bare addon through the same shape as the npm package. */
function adaptAddon(addon: WindowsProcessTreeAddon): WindowsProcessTreeModule {
  return {
    ProcessDataFlag: PROCESS_DATA_FLAG,
    getAllProcesses: (callback, flags) => addon.getProcessList(callback, flags ?? 0)
  }
}

/**
 * Resolve the native reader, or null where it cannot be used.
 *
 * Two sources, because two very different deployments need it. The desktop app
 * installs the npm package. A relay host has no node_modules of ours at all, so
 * build-relay stages the bare addon next to the bundle and we bind to that.
 */
export function loadWindowsProcessTree(): WindowsProcessTreeModule | null {
  if (cachedModule !== undefined) {
    return cachedModule
  }
  if (process.platform !== 'win32') {
    cachedModule = null
    return cachedModule
  }
  try {
    const candidate = requireNative('@vscode/windows-process-tree')
    if (isWindowsProcessTreeModule(candidate)) {
      cachedModule = candidate
      return cachedModule
    }
    // A malformed package can coexist with a usable relay addon.
    throw new Error('invalid windows process tree module')
  } catch {
    // Not an error here: the relay never has the package. Try the staged addon.
  }
  try {
    const addon = requireNative(RELAY_ADDON_FILENAME) as WindowsProcessTreeAddon
    // Why check the shape: a truncated upload or an addon built for another
    // arch can load and still not answer. Binding to it would then reject every
    // read forever, where falling through reaches a scan that works.
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

export function resetWindowsProcessTreeLoaderForTests(): void {
  cachedModule = undefined
}

export function setWindowsProcessTreeRequireForTests(resolve?: NativeRequire): void {
  requireNative = resolve ?? requireFromMain
  resetWindowsProcessTreeLoaderForTests()
}
