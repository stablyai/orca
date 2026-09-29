import { createRequire } from 'node:module'
import { quoteWindowsArgument } from '../shared/child-process/windows-command-line'

type Pointer = number | bigint
type BunFfi = {
  dlopen<T>(
    name: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>
  ): {
    symbols: T
    close(): void
  }
  ptr(view: ArrayBufferView): Pointer
}
type Kernel32 = {
  CreateFileW(
    path: Pointer,
    access: number,
    share: number,
    security: Pointer,
    creation: number,
    flags: number,
    template: null
  ): Pointer
  InitializeProcThreadAttributeList(
    list: Pointer | null,
    count: number,
    flags: number,
    size: Pointer
  ): number
  UpdateProcThreadAttribute(
    list: Pointer,
    flags: number,
    attribute: number,
    value: Pointer,
    size: number,
    previous: null,
    returnedSize: null
  ): number
  DeleteProcThreadAttributeList(list: Pointer): void
  CreateProcessW(
    application: Pointer,
    command: Pointer,
    processSecurity: null,
    threadSecurity: null,
    inheritHandles: number,
    flags: number,
    environment: null,
    cwd: Pointer,
    startup: Pointer,
    result: Pointer
  ): number
  GetLastError(): number
  CloseHandle(handle: Pointer): number
}

export type WindowsDetachedRelayLaunch = {
  executable: string
  args: readonly string[]
  cwd: string
  stdoutPath: string
  stderrPath: string
}
const requireFromRelay = createRequire(__filename)
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn

function wide(value: string): Uint16Array {
  if (value.includes('\0')) {
    throw new Error('Windows launch argument contains NUL')
  }
  const encoded = new Uint16Array(value.length + 1)
  for (let index = 0; index < value.length; index += 1) {
    encoded[index] = value.charCodeAt(index)
  }
  return encoded
}

export function launchDetachedWindowsRelay(options: WindowsDetachedRelayLaunch): number {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('Detached relay launch requires 64-bit Windows')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned Bun runtime provides this FFI interface; load failures propagate.
  const ffi = requireFromRelay('bun:ffi') as BunFfi
  const library = ffi.dlopen<Kernel32>('kernel32.dll', {
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'ptr'], returns: 'u64' },
    InitializeProcThreadAttributeList: { args: ['ptr', 'u32', 'u32', 'ptr'], returns: 'i32' },
    UpdateProcThreadAttribute: {
      args: ['ptr', 'u32', 'u64', 'ptr', 'u64', 'ptr', 'ptr'],
      returns: 'i32'
    },
    DeleteProcThreadAttributeList: { args: ['ptr'], returns: 'void' },
    CreateProcessW: {
      args: ['ptr', 'ptr', 'ptr', 'ptr', 'i32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr'],
      returns: 'i32'
    },
    GetLastError: { args: [], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'i32' }
  })
  const api = library.symbols
  const readLastErrorCode = api.GetLastError
  function nativeFailureMessage(message: string): string {
    // Last-error can change across FFI; keep it diagnostic, never a retry decision.
    const hint = readLastErrorCode()
    return hint ? `${message} (Win32 last-error hint ${hint})` : message
  }
  const handles: Pointer[] = []
  let attributes: Uint8Array | undefined
  let attributeHandles: BigUint64Array | undefined
  try {
    const application = wide(options.executable)
    const command = wide([options.executable, ...options.args].map(quoteWindowsArgument).join(' '))
    if (command.length > 32767) {
      throw new Error('Windows relay command exceeds the platform limit')
    }
    const cwd = wide(options.cwd)
    const security = new Uint8Array(24)
    const securityView = new DataView(security.buffer)
    securityView.setUint32(0, security.byteLength, true)
    securityView.setUint32(16, 1, true)
    function open(path: string, access: number, creation: number): Pointer {
      const name = wide(path)
      const handle = api.CreateFileW(
        ffi.ptr(name),
        access,
        7,
        ffi.ptr(security),
        creation,
        0x80,
        null
      )
      if (BigInt.asUintN(64, BigInt(handle)) === INVALID_HANDLE || handle === 0 || handle === 0n) {
        throw new Error(nativeFailureMessage('Unable to open detached relay standard stream'))
      }
      handles.push(handle)
      return handle
    }
    const input = open('NUL', 0x80000000, 3)
    // Append and share-delete preserve pre-JS errors without preventing daemon log rotation.
    const output = open(options.stdoutPath, 4, 4)
    const error = open(options.stderrPath, 4, 4)
    const size = new BigUint64Array(1)
    api.InitializeProcThreadAttributeList(null, 1, 0, ffi.ptr(size))
    if (size[0] === 0n || size[0] > 65536n) {
      throw new Error('Invalid Windows attribute-list size')
    }
    const storage = new Uint8Array(Number(size[0]))
    if (!api.InitializeProcThreadAttributeList(ffi.ptr(storage), 1, 0, ffi.ptr(size))) {
      throw new Error(nativeFailureMessage('Unable to initialize Windows handle allowlist'))
    }
    attributes = storage
    const allowed = new BigUint64Array([BigInt(input), BigInt(output), BigInt(error)])
    attributeHandles = allowed
    if (
      !api.UpdateProcThreadAttribute(
        ffi.ptr(attributes),
        0,
        0x00020002,
        ffi.ptr(allowed),
        allowed.byteLength,
        null,
        null
      )
    ) {
      throw new Error(nativeFailureMessage('Unable to restrict inherited Windows handles'))
    }
    const startup = new Uint8Array(112)
    const startupView = new DataView(startup.buffer)
    startupView.setUint32(0, startup.byteLength, true)
    startupView.setUint32(60, 0x100, true)
    startupView.setBigUint64(80, BigInt(input), true)
    startupView.setBigUint64(88, BigInt(output), true)
    startupView.setBigUint64(96, BigInt(error), true)
    startupView.setBigUint64(104, BigInt(ffi.ptr(attributes)), true)
    const result = new Uint8Array(24)
    // Break away from sshd's job; inherit only our three standard-stream handles.
    const flags = 0x01000000 | 0x08000000 | 0x00080000
    if (
      !api.CreateProcessW(
        ffi.ptr(application),
        ffi.ptr(command),
        null,
        null,
        1,
        flags,
        null,
        ffi.ptr(cwd),
        ffi.ptr(startup),
        ffi.ptr(result)
      )
    ) {
      throw new Error(
        nativeFailureMessage('Unable to start detached relay with Windows job breakaway')
      )
    }
    const processInfo = new DataView(result.buffer)
    handles.push(processInfo.getBigUint64(0, true), processInfo.getBigUint64(8, true))
    return processInfo.getUint32(16, true)
  } finally {
    if (attributes) {
      api.DeleteProcThreadAttributeList(ffi.ptr(attributes))
      // The attribute API retains this buffer until the list is destroyed.
      attributeHandles?.fill(0n)
    }
    for (const handle of handles.toReversed()) {
      api.CloseHandle(handle)
    }
    library.close()
  }
}
