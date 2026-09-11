// Decodes MINIDUMP_EXCEPTION_STREAM: what faulted, where, and the instruction
// that did it.
//
// Why the instruction needs its own decode: ExceptionAddress means different
// things per platform *and* per exception class.
//
//  - Windows writes EXCEPTION_RECORD.ExceptionAddress, always the faulting
//    instruction.
//  - Crashpad's Mach snapshot writes code[1] — the inaccessible data address —
//    for EXC_BAD_ACCESS, and the CONTEXT instruction pointer for every other
//    Mach exception (snapshot/mac/exception_snapshot_mac.cc).
//  - Crashpad's POSIX snapshot writes siginfo.si_addr, which sigaction(2)
//    defines as the faulting instruction for SIGILL/SIGFPE but as the memory
//    reference that faulted for SIGSEGV/SIGBUS, and leaves undefined for the
//    rest — SIGTRAP arrives as 0x0.
//
// A data address lands inside a mapped image often enough to name the wrong
// module — a store through a bad pointer into a shared object's read-only page
// is the everyday shape — so for those classes the instruction pointer is read
// from the crashing thread's CONTEXT instead.
//
// Layouts are from Crashpad's minidump_extensions.h and the Windows MINIDUMP_*
// structs; every read is bounds-checked and a malformed dump degrades to null.

import { findStream, type LocationDescriptor, type MinidumpView } from './minidump-stream-reader'

const STREAM_TYPE_EXCEPTION = 6

// MINIDUMP_EXCEPTION_STREAM: ThreadId u32, __alignment u32, then MINIDUMP_EXCEPTION
// (ExceptionCode, ExceptionFlags, ExceptionRecord, ExceptionAddress,
// NumberParameters, __unusedAlignment, ExceptionInformation[15]), then ThreadContext.
const EXCEPTION_RECORD_OFFSET = 8
const EXCEPTION_CODE_OFFSET = EXCEPTION_RECORD_OFFSET + 0
const EXCEPTION_ADDRESS_OFFSET = EXCEPTION_RECORD_OFFSET + 16
const EXCEPTION_NUMBER_PARAMETERS_OFFSET = EXCEPTION_RECORD_OFFSET + 24
const EXCEPTION_INFORMATION_OFFSET = EXCEPTION_RECORD_OFFSET + 32
const EXCEPTION_THREAD_CONTEXT_OFFSET = 160
const EXCEPTION_STREAM_SIZE = 168

// MINIDUMP_SYSTEM_INFO: ProcessorArchitecture u16 at +0, PlatformId u32 at +20.
const STREAM_TYPE_SYSTEM_INFO = 7
const SYSTEM_INFO_PLATFORM_ID_OFFSET = 20
const SYSTEM_INFO_MIN_BYTES = SYSTEM_INFO_PLATFORM_ID_OFFSET + 4
// Crashpad's MinidumpOS. WIN32_NT is the one platform whose ExceptionAddress is
// contractually the faulting instruction whatever the exception class.
const PLATFORM_WIN32_NT = 2
const PLATFORM_MACOS = 0x8101
const PLATFORM_IOS = 0x8102
const PLATFORM_LINUX = 0x8201
const PLATFORM_ANDROID = 0x8203

const MACH_PLATFORMS = [PLATFORM_MACOS, PLATFORM_IOS]
const POSIX_PLATFORMS = [PLATFORM_LINUX, PLATFORM_ANDROID]

// The one Mach exception whose ExceptionAddress Crashpad takes from code[1].
const EXC_BAD_ACCESS = 1
// Signals whose si_addr sigaction(2) defines as the faulting instruction...
const SIGILL = 4
const SIGFPE = 8
// ...and the two where it is the memory reference that faulted instead.
const SIGBUS = 7
const SIGSEGV = 11

const CPU_ARCHITECTURE_AMD64 = 9
const CPU_ARCHITECTURE_ARM64 = 12
// Breakpad's pre-standard arm64 selector, still emitted by some producers.
const CPU_ARCHITECTURE_ARM64_BREAKPAD = 0x8003

const ARM64_ARCHITECTURES = [CPU_ARCHITECTURE_ARM64, CPU_ARCHITECTURE_ARM64_BREAKPAD]
// Windows' ARM64_NT_CONTEXT: the largest arm64 CONTEXT any producer writes.
const ARM64_CONTEXT_MAX_BYTES = 912

// CONTEXT_CONTROL: Rip/Pc live in the control group of the Windows-shaped contexts.
const CONTEXT_CONTROL_FLAG = 0x1
// Breakpad's legacy arm64 context has no control group; Pc is iregs[32], so the
// integer group is what says it is populated (there is no MD_CONTEXT_ARM64_CONTROL_OLD).
const CONTEXT_INTEGER_FLAG = 0x2

type ContextLayout = {
  readonly architectures: readonly number[]
  /** Smallest CONTEXT any producer writes for this layout. */
  readonly minBytes: number
  /**
   * Largest CONTEXT any producer writes for this layout, where one exists.
   * Every arm64 struct is smaller than CONTEXT_AMD64, so without a ceiling an
   * amd64 context that fails to name its own architecture — ContextFlags zeroed
   * by a partial write, or a MINIDUMP_SYSTEM_INFO that disagrees with it —
   * reaches the arm64 layouts, which read CONTEXT_AMD64's P1Home as
   * context_flags and a float-save-area word as Pc. amd64 needs no ceiling: its
   * floor already sits above every arm64 struct, and an XSTATE-extended x64
   * context runs past 1232 bytes.
   */
  readonly maxBytes?: number
  readonly flagsOffset: number
  /** CONTEXT_<arch> selector; a context has to name its own architecture. */
  readonly architectureFlag: number
  /** Group flag that has to be set for the instruction pointer to be populated. */
  readonly instructionPointerFlag: number
  readonly instructionPointerOffset: number
}

/**
 * Only x86-64 and arm64 CONTEXTs are decoded — those are what Orca ships (x64
 * everywhere, arm64 on Apple Silicon and Linux). An x86-32, arm32 or any other
 * dump reports no instruction pointer rather than misreading foreign registers.
 *
 * The two arm64 entries are different structs, not one struct with two names:
 * Breakpad's legacy MDRawContextARM64_Old opens with a u64 context_flags and
 * puts iregs[33] straight after it, while the modern MDRawContextARM64 (and
 * Crashpad's) opens u32 context_flags + u32 cpsr. Pc lands at +0x108 either way
 * — 8 + 32*8 in the old layout, after regs[31]+sp in the new one — so only the
 * flags differ, and the flags are what tells the two apart.
 */
const CONTEXT_LAYOUTS: readonly ContextLayout[] = [
  {
    architectures: [CPU_ARCHITECTURE_AMD64],
    minBytes: 1_232,
    flagsOffset: 0x30, // after P1Home..P6Home
    architectureFlag: 0x0010_0000,
    instructionPointerFlag: CONTEXT_CONTROL_FLAG,
    instructionPointerOffset: 0xf8 // Rip
  },
  {
    architectures: ARM64_ARCHITECTURES,
    minBytes: 792, // Crashpad's MinidumpContextARM64; Windows' ARM64_NT_CONTEXT is 912
    maxBytes: ARM64_CONTEXT_MAX_BYTES,
    flagsOffset: 0,
    architectureFlag: 0x0040_0000,
    instructionPointerFlag: CONTEXT_CONTROL_FLAG,
    instructionPointerOffset: 0x108 // Pc
  },
  {
    architectures: ARM64_ARCHITECTURES,
    minBytes: 796, // MDRawContextARM64_Old; producers emit 796 packed or 800 naturally aligned
    maxBytes: ARM64_CONTEXT_MAX_BYTES,
    flagsOffset: 0, // low half of the u64 context_flags
    architectureFlag: 0x8000_0000,
    instructionPointerFlag: CONTEXT_INTEGER_FLAG,
    instructionPointerOffset: 0x108 // iregs[32], the Pc
  }
]

/** `&` yields an int32, so bit 31 has to be folded back to unsigned before comparing. */
function hasFlags(flags: number, mask: number): boolean {
  return (flags & mask) >>> 0 === mask
}

const STATUS_ACCESS_VIOLATION = 0xc0000005
const STATUS_IN_PAGE_ERROR = 0xc0000006

export type AccessViolationKind = 'read' | 'write' | 'execute'

const ACCESS_VIOLATION_KINDS: Readonly<Record<number, AccessViolationKind>> = {
  0: 'read',
  1: 'write',
  8: 'execute'
}

export type MinidumpExceptionRecord = {
  /** Win32 exception code / POSIX signal number. */
  readonly code?: number
  /** ExceptionAddress verbatim: the instruction on Windows, si_addr on POSIX. */
  readonly address?: bigint
  /**
   * Faulting instruction, from the crashing thread's CONTEXT. A trap frame
   * (x86 int3) can report past the trapping instruction, so this is a
   * disassembly starting point rather than an exact address.
   */
  readonly instructionPointer?: bigint
  /**
   * The address a module may be attributed to: ExceptionAddress wherever the
   * platform and exception class say it is an instruction, else the CONTEXT
   * instruction pointer. Absent rather than falling back to a POSIX/Mach data
   * address, which would name whatever image the crash touched as the code
   * that ran.
   */
  readonly codeAddress?: bigint
  readonly accessKind?: AccessViolationKind
  readonly accessAddress?: bigint
}

type SystemInfo = {
  readonly architecture: number | null
  readonly platformId: number | null
}

function readSystemInfo(view: MinidumpView): SystemInfo {
  const stream = findStream(view, STREAM_TYPE_SYSTEM_INFO)
  // A stream too short to hold PlatformId would otherwise read it from whatever
  // follows, and a stray 2 there classifies a POSIX dump as Windows.
  if (!stream || stream.size < SYSTEM_INFO_MIN_BYTES) {
    return { architecture: null, platformId: null }
  }
  return {
    architecture: view.u16(stream.rva),
    platformId: view.u32(stream.rva + SYSTEM_INFO_PLATFORM_ID_OFFSET)
  }
}

/**
 * MINIDUMP_SYSTEM_INFO.ProcessorArchitecture narrows the candidate layouts, but
 * only when it names an architecture a layout covers: a zeroed or truncated
 * stream reads back as 0 (PROCESSOR_ARCHITECTURE_INTEL), and treating that as
 * authoritative would kill the instruction pointer outright — worse than the
 * dump carrying no system info at all. An unrecognised value therefore falls
 * back to matching on the declared context size and the context's own
 * CONTEXT_<arch> selector, which is the real guard either way.
 */
function candidateArchitecture(architecture: number | null): number | null {
  if (architecture === null) {
    return null
  }
  const known = CONTEXT_LAYOUTS.some((layout) => layout.architectures.includes(architecture))
  return known ? architecture : null
}

function readInstructionPointer(
  view: MinidumpView,
  exception: LocationDescriptor,
  architecture: number | null
): bigint | null {
  if (exception.size < EXCEPTION_STREAM_SIZE) {
    return null
  }
  const context = view.location(exception.rva + EXCEPTION_THREAD_CONTEXT_OFFSET)
  if (!context) {
    return null
  }
  const declared = candidateArchitecture(architecture)
  for (const layout of CONTEXT_LAYOUTS) {
    if (declared !== null && !layout.architectures.includes(declared)) {
      continue
    }
    // Outside the architecture's own struct size the context is truncated or
    // foreign; the layouts' byte windows do not overlap, so a context of one
    // architecture's size is never offered to another's struct.
    if (context.size < layout.minBytes || context.size > (layout.maxBytes ?? Infinity)) {
      continue
    }
    if (context.rva + layout.minBytes > view.byteLength) {
      continue
    }
    const flags = view.u32(context.rva + layout.flagsOffset)
    if (flags === null || !hasFlags(flags, layout.architectureFlag)) {
      continue
    }
    // The context named this layout's architecture, so this layout decodes it or
    // nothing does. Falling through to the next would re-read the same bytes
    // under a foreign struct — CONTEXT_AMD64's P1Home doubles as the arm64
    // context_flags slot — and hand back a float-save-area word as a Pc.
    if (!hasFlags(flags, layout.instructionPointerFlag)) {
      return null
    }
    const pointer = view.u64(context.rva + layout.instructionPointerOffset)
    return pointer === null || pointer === 0n ? null : pointer
  }
  return null
}

type ExceptionAddressKind = 'instruction' | 'data' | 'unknown'

/**
 * What ExceptionAddress holds for this platform and exception class — see the
 * file header. Anything the dump does not pin down stays `unknown`, which
 * attributes no module rather than a guessed one.
 */
function classifyExceptionAddress(
  platformId: number | null,
  code: number | null
): ExceptionAddressKind {
  if (platformId === PLATFORM_WIN32_NT) {
    return 'instruction'
  }
  if (code === null || platformId === null) {
    return 'unknown'
  }
  if (MACH_PLATFORMS.includes(platformId)) {
    return code === EXC_BAD_ACCESS ? 'data' : 'instruction'
  }
  if (POSIX_PLATFORMS.includes(platformId)) {
    if (code === SIGILL || code === SIGFPE) {
      return 'instruction'
    }
    return code === SIGSEGV || code === SIGBUS ? 'data' : 'unknown'
  }
  return 'unknown'
}

/**
 * 0x0 is Crashpad's "no address", not an address: SIGTRAP's undefined si_addr
 * and a Windows dump captured with no exception pointers both land there.
 */
function presentAddress(address: bigint | null): bigint | null {
  return address === null || address === 0n ? null : address
}

/**
 * ExceptionInformation[0]/[1] of a Windows access violation: access kind and
 * the inaccessible address, which is what separates a null deref from a wild
 * pointer from a write to read-only memory. Gated on the Win32 status codes
 * because Crashpad's POSIX writer puts si_code in the same slot.
 */
function readAccessViolation(
  view: MinidumpView,
  exception: LocationDescriptor,
  code: number
): { kind?: AccessViolationKind; address: bigint } | null {
  if (code !== STATUS_ACCESS_VIOLATION && code !== STATUS_IN_PAGE_ERROR) {
    return null
  }
  const parameters = view.u32(exception.rva + EXCEPTION_NUMBER_PARAMETERS_OFFSET)
  if (parameters === null || parameters < 2 || exception.size < EXCEPTION_INFORMATION_OFFSET + 16) {
    return null
  }
  const kind = view.u64(exception.rva + EXCEPTION_INFORMATION_OFFSET)
  const address = view.u64(exception.rva + EXCEPTION_INFORMATION_OFFSET + 8)
  if (kind === null || address === null) {
    return null
  }
  return { kind: ACCESS_VIOLATION_KINDS[Number(kind)], address }
}

/** Reads the exception stream, or null when the dump carries none. */
export function readExceptionRecord(view: MinidumpView): MinidumpExceptionRecord | null {
  const exception = findStream(view, STREAM_TYPE_EXCEPTION)
  if (!exception) {
    return null
  }
  const systemInfo = readSystemInfo(view)
  const code = view.u32(exception.rva + EXCEPTION_CODE_OFFSET)
  const address = view.u64(exception.rva + EXCEPTION_ADDRESS_OFFSET)
  const instructionPointer = readInstructionPointer(view, exception, systemInfo.architecture)
  const access = code === null ? null : readAccessViolation(view, exception, code)
  const exceptionAddressInstruction =
    classifyExceptionAddress(systemInfo.platformId, code) === 'instruction'
      ? presentAddress(address)
      : null
  // Windows leads with ExceptionAddress: it is what the whole Win64 field corpus
  // already resolves from, and Windows defines it as the faulting instruction
  // for every exception class. Elsewhere the CONTEXT leads, with ExceptionAddress
  // kept as the fallback for the classes that do set it from the instruction —
  // a Mach EXC_BREAKPOINT resolves from it today and must keep doing so.
  const codeAddress =
    systemInfo.platformId === PLATFORM_WIN32_NT
      ? (exceptionAddressInstruction ?? instructionPointer)
      : (instructionPointer ?? exceptionAddressInstruction)
  return {
    ...(code === null ? {} : { code }),
    ...(address === null ? {} : { address }),
    ...(instructionPointer === null ? {} : { instructionPointer }),
    ...(codeAddress === null ? {} : { codeAddress }),
    ...(access?.kind ? { accessKind: access.kind } : {}),
    ...(access ? { accessAddress: access.address } : {})
  }
}
