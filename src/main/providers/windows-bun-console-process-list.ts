import { createRequire } from 'node:module'

export const WINDOWS_BUN_CONSOLE_LIST_ARGUMENT = '--console-process-list'
const MAX_CONSOLE_PROCESS_IDS = 16_384

type ConsoleApi = {
  detach(): void
  attach(pid: number): boolean
  read(processIds: Uint32Array): number
}

type BunConsoleFfi = {
  ptr(value: Uint32Array): number | bigint
  dlopen(
    path: string,
    symbols: Record<string, { args: string[]; returns: string }>
  ): {
    symbols: {
      FreeConsole(): number
      AttachConsole(pid: number): number
      GetConsoleProcessList(pointer: number | bigint, capacity: number): number
    }
  }
}

function loadBunConsoleApi(): ConsoleApi | null {
  if (process.platform !== 'win32' || !process.versions.bun) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pinned Bun provides FFI; failures are caught by the child query and reported as unavailable.
  const ffi = createRequire(__filename)('bun:ffi') as BunConsoleFfi
  const { symbols } = ffi.dlopen('kernel32.dll', {
    FreeConsole: { args: [], returns: 'i32' },
    AttachConsole: { args: ['u32'], returns: 'i32' },
    GetConsoleProcessList: { args: ['ptr', 'u32'], returns: 'u32' }
  })
  return {
    detach: () => {
      symbols.FreeConsole()
    },
    attach: (pid) => symbols.AttachConsole(pid) !== 0,
    read: (ids) => symbols.GetConsoleProcessList(ffi.ptr(ids), ids.length)
  }
}

/** Child-process only: attaching a console changes the caller's console ownership. */
export function readWindowsBunConsoleProcessList(
  pid: number,
  load: () => ConsoleApi | null = loadBunConsoleApi
): number[] | null {
  // 0xffffffff selects the parent's console rather than a process ID.
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid >= 0xffff_ffff) {
    return null
  }
  let api: ConsoleApi | null = null
  try {
    api = load()
    if (!api) {
      return null
    }
    api.detach()
    if (!api.attach(pid)) {
      return null
    }
    for (let capacity = 64; capacity <= MAX_CONSOLE_PROCESS_IDS; capacity *= 4) {
      const ids = new Uint32Array(capacity)
      const count = api.read(ids)
      if (!Number.isInteger(count) || count <= 0) {
        return null
      }
      if (count <= capacity) {
        return [...ids.subarray(0, count)]
      }
    }
    return null
  } catch {
    return null
  } finally {
    try {
      api?.detach()
    } catch {
      // The short-lived query process releases its console when it exits.
    }
  }
}
