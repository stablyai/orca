// Extracts the diagnosable parts of a Crashpad minidump without symbols.
//
// Why: a Chromium CHECK/DCHECK surfaces to `render-process-gone` as exit code
// 0x80000003 (STATUS_BREAKPOINT) and nothing else, so the exit code alone can
// never name the failing check. Some Crashpad builds expose the fatal line as
// `LOG_FATAL`; Electron 43 on Windows only carries it in captured process
// memory. Both forms are recoverable without symbols or minidump_stackwalk.
//
// Layouts are from Crashpad's minidump_extensions.h and the Windows
// MINIDUMP_* structs. Everything here is bounds-checked and returns null
// rather than throwing: a truncated dump must degrade, not break crash
// reporting.

import { findStream, isMinidump, MinidumpView } from './minidump-stream-reader'
import { readExceptionRecord, type AccessViolationKind } from './minidump-exception-record'
import { readCrashpadAnnotations } from './minidump-crashpad-annotations'

const STREAM_TYPE_MODULE_LIST = 4

const MODULE_RECORD_SIZE = 108
// 8x headroom over a measured 1042-image macOS renderer, whose whole list a
// 1_024 cap dropped; a dump claiming more than this is corrupt.
const MAX_MODULE_LIST_MODULES = 8_192
const MODULE_BASE_OFFSET = 0
const MODULE_SIZE_OFFSET = 8
const MODULE_NAME_RVA_OFFSET = 20

const CHROMIUM_LOG_MARKERS = [
  Buffer.from(':FATAL:', 'ascii'),
  Buffer.from(':CHECK:', 'ascii'),
  Buffer.from(':DFATAL:', 'ascii'),
  Buffer.from(':ERROR:', 'ascii')
]
const MAX_LOG_PREFIX_BYTES = 96
const MAX_CHECK_LOG_BYTES = 4_000
const MAX_MARKERS_PER_SEVERITY = 256
const CHECK_LOG_PATTERN =
  /^\[(?:\d+:){1,2}\d{4}\/\d{6}\.\d{3,6}:(FATAL|CHECK|DFATAL|ERROR)(?::[^:\]\r\n]{1,80})*:([^:\]\r\n]{1,512}?)(?:\((\d+)\)|:(\d+))\]\s*(.+)$/
const ERROR_CHECK_PATTERN = /\b(?:Check failed:|D?CHECK failed:|Intentionally causing D?CHECK\b)/i

export type MinidumpCrashSignature = {
  /** Chromium's fatal log line, e.g. `[...:FATAL:node.cc(123)] Check failed: !x.` */
  readonly checkMessage?: string
  /** Source file basename parsed out of `checkMessage`. */
  readonly checkFile?: string
  readonly checkLine?: number
  /** Crashpad `ptype`: `renderer`, `gpu-process`, `browser`. */
  readonly processType?: string
  /** Win32 exception code / POSIX signal, e.g. 0x80000003 STATUS_BREAKPOINT. */
  readonly exceptionCode?: number
  /**
   * Raw MINIDUMP_EXCEPTION.ExceptionAddress. Windows writes the faulting
   * instruction here; Crashpad's POSIX and Mach snapshots write si_addr and
   * EXC_BAD_ACCESS's code[1], which are the faulting instruction for some
   * exception classes and the data address the fault touched for others (0x0
   * where si_addr is undefined, e.g. SIGTRAP). Reported as-is; never substituted.
   */
  readonly exceptionAddress?: string
  /**
   * Faulting instruction, read from the crashing thread's CONTEXT. A trap frame
   * (x86 int3, arm64 BRK) can report past the trapping instruction, so treat
   * this as a disassembly starting point rather than an exact address.
   */
  readonly instructionPointer?: string
  /**
   * Module whose image range contains the faulting *instruction*. Derived from
   * `exceptionAddress` only where the platform and exception class say that
   * field is an instruction; otherwise the image it lands in is memory the
   * crash touched, not code that ran. See `minidump-exception-record`.
   */
  readonly faultingModule?: string
  readonly faultingModuleOffset?: string
  /** Windows access violations only: what the faulting instruction attempted. */
  readonly accessKind?: AccessViolationKind
  /** Windows access violations only: the address that could not be accessed. */
  readonly accessAddress?: string
  /** Allowlisted Crashpad annotations, verbatim. */
  readonly annotations: Readonly<Record<string, string>>
}

type ModuleRecord = {
  readonly base: bigint
  readonly size: number
  readonly name: string
}

function readModules(view: MinidumpView): ModuleRecord[] {
  const stream = findStream(view, STREAM_TYPE_MODULE_LIST)
  if (!stream) {
    return []
  }
  const count = view.u32(stream.rva)
  if (count === null || count > MAX_MODULE_LIST_MODULES) {
    return []
  }
  const modules: ModuleRecord[] = []
  for (let index = 0; index < count; index += 1) {
    const record = stream.rva + 4 + index * MODULE_RECORD_SIZE
    const base = view.u64(record + MODULE_BASE_OFFSET)
    const size = view.u32(record + MODULE_SIZE_OFFSET)
    const nameRva = view.u32(record + MODULE_NAME_RVA_OFFSET)
    if (base === null || size === null || nameRva === null) {
      break
    }
    const name = view.utf16String(nameRva, 2_048)
    modules.push({ base, size, name: name ?? 'unknown' })
  }
  return modules
}

function moduleBasename(modulePath: string): string {
  const separator = Math.max(modulePath.lastIndexOf('/'), modulePath.lastIndexOf('\\'))
  return separator >= 0 ? modulePath.slice(separator + 1) : modulePath
}

function toHex(value: bigint): string {
  return `0x${value.toString(16)}`
}

type LocatedCheckMessage = {
  readonly message: string
  readonly file?: string
  readonly line?: number
}

function isPrintableLogByte(value: number): boolean {
  return value === 0x09 || (value >= 0x20 && value <= 0x7e)
}

/**
 * `lastIndexOf(byte, from)` restricted to `within` bytes before `from`. An
 * unbounded search scans the whole dump backward on a miss only for the result
 * to be thrown away by the same prefix limit; zero-filled regions are normal in
 * a minidump, so that miss is the common case, not the adversarial one.
 */
function lastIndexOfWithin(dump: Buffer, byte: number, from: number, within: number): number {
  const floor = Math.max(0, from - within)
  for (let at = from; at >= floor; at -= 1) {
    if (dump[at] === byte) {
      return at
    }
  }
  return -1
}

/** Electron 43 omits LOG_FATAL but keeps Chromium's formatted log line in memory. */
function findEmbeddedCheckMessage(dump: Buffer): LocatedCheckMessage | undefined {
  for (const marker of CHROMIUM_LOG_MARKERS) {
    let from = 0
    for (let inspected = 0; inspected < MAX_MARKERS_PER_SEVERITY; inspected += 1) {
      const markerAt = dump.indexOf(marker, from)
      if (markerAt === -1) {
        break
      }
      from = markerAt + marker.length
      const start = lastIndexOfWithin(dump, 0x5b, markerAt, MAX_LOG_PREFIX_BYTES)
      if (start === -1) {
        continue
      }
      let end = markerAt + marker.length
      const limit = Math.min(dump.length, start + MAX_CHECK_LOG_BYTES)
      while (end < limit && isPrintableLogByte(dump[end])) {
        end += 1
      }
      const candidate = dump.subarray(start, end).toString('utf8')
      const match = CHECK_LOG_PATTERN.exec(candidate)
      if (!match || (match[1] === 'ERROR' && !ERROR_CHECK_PATTERN.test(match[5]))) {
        continue
      }
      const line = Number.parseInt(match[3] ?? match[4], 10)
      return {
        message: candidate,
        file: moduleBasename(match[2]),
        line: Number.isFinite(line) ? line : undefined
      }
    }
  }
  return undefined
}

/** Parses the annotation form, which uses `file.cc(123)`. */
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
  /**
   * Process type the caller will accept. A dump from any other process is
   * discarded by the caller anyway, so parsing stops at `processType` and the
   * returned signature is deliberately partial — read only `processType` when
   * it does not match.
   */
  readonly expectedProcessType?: string
}

/**
 * Parses a Crashpad minidump into the fields that make a CHECK failure
 * nameable. Returns null when the buffer is not a minidump.
 */
export function parseMinidumpCrashSignature(
  dump: Buffer,
  options: MinidumpParseOptions = {}
): MinidumpCrashSignature | null {
  if (!isMinidump(dump)) {
    return null
  }
  const view = new MinidumpView(dump)
  const annotations = readCrashpadAnnotations(view)

  const signature: {
    -readonly [K in keyof MinidumpCrashSignature]: MinidumpCrashSignature[K]
  } = { annotations }

  const processType = annotations['ptype']
  if (processType) {
    signature.processType = processType
  }
  // Annotations are bounded; the scans below are not. A renderer crash would
  // otherwise scan every fresh GPU/utility dump end to end before rejecting it.
  if (options.expectedProcessType !== undefined && processType !== options.expectedProcessType) {
    return signature
  }

  const annotatedCheckMessage = annotations['LOG_FATAL'] ?? annotations['abort-message']
  const embeddedCheck = annotatedCheckMessage ? undefined : findEmbeddedCheckMessage(dump)
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
  const exception = readExceptionRecord(view)
  if (exception) {
    const { code, address, instructionPointer, codeAddress, accessKind, accessAddress } = exception
    if (code !== undefined) {
      signature.exceptionCode = code
    }
    if (address !== undefined) {
      signature.exceptionAddress = toHex(address)
    }
    if (instructionPointer !== undefined) {
      signature.instructionPointer = toHex(instructionPointer)
    }
    if (accessKind) {
      signature.accessKind = accessKind
    }
    if (accessAddress !== undefined) {
      signature.accessAddress = toHex(accessAddress)
    }
    if (codeAddress !== undefined) {
      const faulting = findFaultingModule(readModules(view), codeAddress)
      if (faulting) {
        signature.faultingModule = faulting.name
        signature.faultingModuleOffset = faulting.offset
      }
    }
  }

  return signature
}

/** Flattens a signature into `CrashReportRecord.details` keys. */
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
  if (signature.instructionPointer) {
    details.minidumpInstructionPointer = signature.instructionPointer
  }
  if (signature.accessKind) {
    details.minidumpAccessKind = signature.accessKind
  }
  if (signature.accessAddress) {
    details.minidumpAccessAddress = signature.accessAddress
  }
  if (signature.faultingModule) {
    details.minidumpFaultingModule = signature.faultingModule
  }
  if (signature.faultingModuleOffset) {
    details.minidumpFaultingModuleOffset = signature.faultingModuleOffset
  }
  for (const [key, value] of Object.entries(signature.annotations)) {
    if (key === 'LOG_FATAL' || key === 'abort-message' || key === 'ptype') {
      continue
    }
    details[`minidumpAnnotation_${key.replace(/-/g, '_')}`] = value
  }
  return details
}
