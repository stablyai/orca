// Layouts follow Crashpad minidump_extensions.h and Windows MINIDUMP_* structs.

import { findStream, isMinidump, MinidumpView, type MinidumpSource } from './minidump-stream-reader'
import { readCrashpadAnnotations } from './minidump-crashpad-annotations'
import { findEmbeddedCheckMessage } from './minidump-embedded-check'
import { readMinidumpFaultContext, type MinidumpFaultContext } from './minidump-fault-context'

const STREAM_TYPE_MODULE_LIST = 4
const STREAM_TYPE_EXCEPTION = 6
const STREAM_TYPE_SYSTEM_INFO = 7
// Crashpad uses different PlatformId values for macOS and Linux.
const SYSTEM_INFO_PLATFORM_ID_OFFSET = 20
const VER_PLATFORM_WIN32_NT = 2

const MODULE_RECORD_SIZE = 108
// Allow headroom for macOS renderers with over 1,024 loaded images.
const MAX_MODULE_LIST_MODULES = 8_192
const MODULE_BASE_OFFSET = 0
const MODULE_SIZE_OFFSET = 8
const MODULE_NAME_RVA_OFFSET = 20

// MINIDUMP_EXCEPTION_STREAM: ThreadId u32, __alignment u32, then MINIDUMP_EXCEPTION.
const EXCEPTION_RECORD_OFFSET = 8
const EXCEPTION_CODE_OFFSET = EXCEPTION_RECORD_OFFSET + 0
const EXCEPTION_ADDRESS_OFFSET = EXCEPTION_RECORD_OFFSET + 16

export type MinidumpCrashSignature = {
  /** Chromium's fatal log line, e.g. `[...:FATAL:node.cc(123)] Check failed: !x.` */
  readonly checkMessage?: string
  /** Source file basename from the annotated or embedded log line. */
  readonly checkFile?: string
  readonly checkLine?: number
  /** Crashpad `ptype`: `renderer`, `gpu-process`, `browser`. */
  readonly processType?: string
  /** Win32 exception code / POSIX signal, e.g. 0x80000003 STATUS_BREAKPOINT. */
  readonly exceptionCode?: number
  readonly exceptionAddress?: string
  /** Module whose image range contains `exceptionAddress`. */
  readonly faultingModule?: string
  readonly faultingModuleOffset?: string
  readonly fault?: MinidumpFaultContext
  /** Allowlisted Crashpad annotations, verbatim. */
  readonly annotations: Readonly<Record<string, string>>
}

type ModuleRecord = {
  readonly base: bigint
  readonly size: number
  readonly name: string
}

async function readModules(view: MinidumpView): Promise<ModuleRecord[]> {
  const stream = await findStream(view, STREAM_TYPE_MODULE_LIST)
  if (!stream) {
    return []
  }
  const count = await view.u32(stream.rva)
  if (count === null || count > MAX_MODULE_LIST_MODULES) {
    return []
  }
  const modules: ModuleRecord[] = []
  for (let index = 0; index < count; index += 1) {
    const record = stream.rva + 4 + index * MODULE_RECORD_SIZE
    const base = await view.u64(record + MODULE_BASE_OFFSET)
    const size = await view.u32(record + MODULE_SIZE_OFFSET)
    const nameRva = await view.u32(record + MODULE_NAME_RVA_OFFSET)
    if (base === null || size === null || nameRva === null) {
      break
    }
    const name = await view.utf16String(nameRva, 2_048)
    modules.push({ base, size, name: name ?? 'unknown' })
  }
  return modules
}

async function isWindowsDump(view: MinidumpView): Promise<boolean> {
  const stream = await findStream(view, STREAM_TYPE_SYSTEM_INFO)
  return (
    stream !== null &&
    (await view.u32(stream.rva + SYSTEM_INFO_PLATFORM_ID_OFFSET)) === VER_PLATFORM_WIN32_NT
  )
}

function moduleBasename(modulePath: string): string {
  const separator = Math.max(modulePath.lastIndexOf('/'), modulePath.lastIndexOf('\\'))
  return separator >= 0 ? modulePath.slice(separator + 1) : modulePath
}

function toHex(value: bigint): string {
  return `0x${value.toString(16)}`
}

function parseCheckLocation(checkMessage: string): {
  file?: string
  line?: number
} {
  const match = /:(?:FATAL|CHECK|DFATAL)(?::[^:\]]*)?:([^:()\s]+)\((\d+)\)/.exec(checkMessage)
  if (!match) {
    return {}
  }
  const line = Number.parseInt(match[2], 10)
  return { file: match[1], line: Number.isFinite(line) ? line : undefined }
}

function findFaultingModule(
  modules: ModuleRecord[],
  address: bigint
): { name: string; offset: string } | undefined {
  for (const module of modules) {
    if (address >= module.base && address < module.base + BigInt(module.size)) {
      return {
        name: moduleBasename(module.name),
        offset: toHex(address - module.base)
      }
    }
  }
  return undefined
}

export type MinidumpParseOptions = {
  /** On a mismatch, only processType and annotations are populated; skip expensive scans. */
  readonly expectedProcessType?: string
}

/** Returns null for invalid minidump headers; malformed fields may yield a partial signature. */
export async function parseMinidumpCrashSignature(
  dump: Buffer | MinidumpSource,
  options: MinidumpParseOptions = {}
): Promise<MinidumpCrashSignature | null> {
  const source: MinidumpSource = Buffer.isBuffer(dump)
    ? {
        byteLength: dump.length,
        read: async (offset, size) => dump.subarray(offset, offset + size)
      }
    : dump
  if (!isMinidump(await source.read(0, 32))) {
    return null
  }
  const view = new MinidumpView(source)
  const annotations = await readCrashpadAnnotations(view)

  const signature: {
    -readonly [K in keyof MinidumpCrashSignature]: MinidumpCrashSignature[K]
  } = { annotations }

  const processType = annotations['ptype']
  if (processType) {
    signature.processType = processType
  }
  // Reject unrelated dumps before scanning their captured memory for log lines.
  if (options.expectedProcessType !== undefined && processType !== options.expectedProcessType) {
    return signature
  }

  const annotatedCheckMessage = annotations['LOG_FATAL'] ?? annotations['abort-message']
  const embeddedCheck = annotatedCheckMessage ? undefined : await findEmbeddedCheckMessage(source)
  const checkMessage = annotatedCheckMessage ?? embeddedCheck?.message
  if (checkMessage) {
    signature.checkMessage = checkMessage
    const location = embeddedCheck ?? parseCheckLocation(checkMessage)
    if (location.file) {
      signature.checkFile = location.file
    }
    if (location.line !== undefined) {
      signature.checkLine = location.line
    }
  }
  const exception = await findStream(view, STREAM_TYPE_EXCEPTION)
  if (exception) {
    const code = await view.u32(exception.rva + EXCEPTION_CODE_OFFSET)
    const address = await view.u64(exception.rva + EXCEPTION_ADDRESS_OFFSET)
    if (code !== null) {
      signature.exceptionCode = code
    }
    if (address !== null) {
      signature.exceptionAddress = toHex(address)
      const faulting = findFaultingModule(await readModules(view), address)
      if (faulting) {
        signature.faultingModule = faulting.name
        signature.faultingModuleOffset = faulting.offset
      }
      // Capture Windows module code for binary comparison; POSIX may report a data address here.
      signature.fault = await readMinidumpFaultContext(view, exception.rva, code, address, {
        captureCodeBytes: faulting !== undefined && (await isWindowsDump(view))
      })
    }
  }

  return signature
}

export function minidumpSignatureDetails(
  signature: MinidumpCrashSignature
): Record<string, string | number> {
  const details: Record<string, string | number> = {}
  if (signature.checkMessage) {
    details.minidumpCheckMessage = signature.checkMessage
  }
  if (signature.checkFile) {
    details.minidumpCheckFile = signature.checkFile
  }
  if (signature.checkLine !== undefined) {
    details.minidumpCheckLine = signature.checkLine
  }
  if (signature.processType) {
    details.minidumpProcessType = signature.processType
  }
  if (signature.exceptionCode !== undefined) {
    details.minidumpExceptionCode = `0x${(signature.exceptionCode >>> 0).toString(16)}`
  }
  if (signature.exceptionAddress) {
    details.minidumpExceptionAddress = signature.exceptionAddress
  }
  if (signature.faultingModule) {
    details.minidumpFaultingModule = signature.faultingModule
  }
  if (signature.faultingModuleOffset) {
    details.minidumpFaultingModuleOffset = signature.faultingModuleOffset
  }
  const fault = signature.fault
  if (fault?.access) {
    details.minidumpExceptionAccess = fault.access
  }
  if (fault?.faultAddress) {
    details.minidumpFaultAddress = fault.faultAddress
  }
  if (fault?.faultStackPointerDelta !== undefined) {
    details.minidumpFaultStackPointerDelta = fault.faultStackPointerDelta
  }
  if (fault?.codeBytes) {
    details.minidumpCodeBytes = fault.codeBytes
  }
  for (const [key, value] of Object.entries(signature.annotations)) {
    if (key === 'LOG_FATAL' || key === 'abort-message' || key === 'ptype') {
      continue
    }
    details[`minidumpAnnotation_${key.replace(/-/g, '_')}`] = value
  }
  return details
}
