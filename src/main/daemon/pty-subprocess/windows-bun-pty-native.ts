import { createRequire } from 'node:module'

export type WindowsNativeHandle = number | bigint
type NativePointer = number | bigint

export type WindowsBunPtyJobNative = {
  createJob(): WindowsNativeHandle | null
  configureJob(job: WindowsNativeHandle, flags: number): boolean
  currentProcess(): WindowsNativeHandle
  openProcess(access: number, pid: number): WindowsNativeHandle | null
  assignProcess(job: WindowsNativeHandle, process: WindowsNativeHandle): boolean
  isProcessInJob(process: WindowsNativeHandle, job: WindowsNativeHandle): boolean
  queryProcessIds(job: WindowsNativeHandle): readonly number[] | null
  suspendProcess(process: WindowsNativeHandle): boolean
  resumeProcess(process: WindowsNativeHandle): boolean
  terminateJob(job: WindowsNativeHandle): boolean
  closeHandle(handle: WindowsNativeHandle): void
}

type FfiFunction = { args: readonly string[]; returns: string }
type FfiLibrary<T> = { symbols: T }
type BunFfi = {
  dlopen<T>(name: string, symbols: Record<string, FfiFunction>): FfiLibrary<T>
  ptr(view: ArrayBufferView): NativePointer
}

type Kernel32 = {
  CreateJobObjectW(attributes: null, name: null): WindowsNativeHandle | null
  SetInformationJobObject(
    job: WindowsNativeHandle,
    infoClass: number,
    info: NativePointer,
    infoLength: number
  ): number
  GetCurrentProcess(): WindowsNativeHandle
  OpenProcess(access: number, inherit: number, pid: number): WindowsNativeHandle | null
  AssignProcessToJobObject(job: WindowsNativeHandle, process: WindowsNativeHandle): number
  IsProcessInJob(
    process: WindowsNativeHandle,
    job: WindowsNativeHandle,
    result: NativePointer
  ): number
  QueryInformationJobObject(
    job: WindowsNativeHandle,
    infoClass: number,
    info: NativePointer,
    infoLength: number,
    returnLength: null
  ): number
  TerminateJobObject(job: WindowsNativeHandle, exitCode: number): number
  CloseHandle(handle: WindowsNativeHandle): number
  GetLastError(): number
}

type Ntdll = {
  NtSuspendProcess(process: WindowsNativeHandle): number
  NtResumeProcess(process: WindowsNativeHandle): number
}

const requireFromMain = createRequire(__filename)
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3
const JOB_LIMIT_FLAGS_OFFSET = 16
const JOB_EXTENDED_LIMITS_BYTES = 144
const ERROR_MORE_DATA = 234
const MAX_JOB_PROCESS_IDS = 16_384

let cachedNative: WindowsBunPtyJobNative | null | undefined

export function loadWindowsBunPtyJobNative(): WindowsBunPtyJobNative | null {
  if (cachedNative !== undefined) {
    return cachedNative
  }
  if (process.platform !== 'win32') {
    cachedNative = null
    return cachedNative
  }
  try {
    const ffi = requireFromMain('bun:ffi') as BunFfi
    const kernel = ffi.dlopen<Kernel32>('kernel32.dll', {
      CreateJobObjectW: { args: ['ptr', 'ptr'], returns: 'ptr' },
      SetInformationJobObject: { args: ['ptr', 'u32', 'ptr', 'u32'], returns: 'i32' },
      GetCurrentProcess: { args: [], returns: 'ptr' },
      OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'ptr' },
      AssignProcessToJobObject: { args: ['ptr', 'ptr'], returns: 'i32' },
      IsProcessInJob: { args: ['ptr', 'ptr', 'ptr'], returns: 'i32' },
      QueryInformationJobObject: {
        args: ['ptr', 'u32', 'ptr', 'u32', 'ptr'],
        returns: 'i32'
      },
      TerminateJobObject: { args: ['ptr', 'u32'], returns: 'i32' },
      CloseHandle: { args: ['ptr'], returns: 'i32' },
      GetLastError: { args: [], returns: 'u32' }
    })
    const ntdll = ffi.dlopen<Ntdll>('ntdll.dll', {
      NtSuspendProcess: { args: ['ptr'], returns: 'i32' },
      NtResumeProcess: { args: ['ptr'], returns: 'i32' }
    })
    const { symbols } = kernel
    const readLastSystemError = symbols.GetLastError
    cachedNative = {
      createJob: () => symbols.CreateJobObjectW(null, null),
      configureJob(job, flags) {
        const limits = new Uint8Array(JOB_EXTENDED_LIMITS_BYTES)
        new DataView(limits.buffer).setUint32(JOB_LIMIT_FLAGS_OFFSET, flags, true)
        return (
          symbols.SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ffi.ptr(limits),
            limits.byteLength
          ) !== 0
        )
      },
      currentProcess: () => symbols.GetCurrentProcess(),
      openProcess: (access, pid) => symbols.OpenProcess(access, 0, pid),
      assignProcess: (job, process) => symbols.AssignProcessToJobObject(job, process) !== 0,
      isProcessInJob(process, job) {
        const result = new Uint32Array(1)
        return symbols.IsProcessInJob(process, job, ffi.ptr(result)) !== 0 && result[0] !== 0
      },
      queryProcessIds(job) {
        for (let capacity = 64; capacity <= MAX_JOB_PROCESS_IDS; capacity *= 4) {
          const bytes = new Uint8Array(8 + capacity * 8)
          const queried = symbols.QueryInformationJobObject(
            job,
            JOB_OBJECT_BASIC_PROCESS_ID_LIST,
            ffi.ptr(bytes),
            bytes.byteLength,
            null
          )
          const view = new DataView(bytes.buffer)
          if (queried === 0) {
            if (readLastSystemError() !== ERROR_MORE_DATA) {
              return null
            }
            continue
          }
          const count = view.getUint32(4, true)
          if (count > capacity) {
            return null
          }
          const pids: number[] = []
          for (let index = 0; index < count; index += 1) {
            const pid = Number(view.getBigUint64(8 + index * 8, true))
            if (Number.isInteger(pid) && pid > 0) {
              pids.push(pid)
            }
          }
          return pids
        }
        return null
      },
      suspendProcess: (process) => ntdll.symbols.NtSuspendProcess(process) >= 0,
      resumeProcess: (process) => ntdll.symbols.NtResumeProcess(process) >= 0,
      terminateJob: (job) => symbols.TerminateJobObject(job, 1) !== 0,
      closeHandle: (handle) => {
        symbols.CloseHandle(handle)
      }
    }
    return cachedNative
  } catch {
    cachedNative = null
    return cachedNative
  }
}

export function __resetWindowsBunPtyNativeForTests(): void {
  cachedNative = undefined
}
