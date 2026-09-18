import { describe, expect, it } from 'vitest'
import { minidumpSignatureDetails, parseMinidumpCrashSignature } from './minidump-crash-signature'

// scan5: report 6c1f4289 (v1.4.200, linux x64, renderer SIGSEGV) carried
// minidumpExceptionCode 0xb and minidumpExceptionAddress 0x31b58e9fc608 but no
// minidumpFaultingModule, while every Win64 report in the same scan resolved one
// (45/45 vs 0/3 on Linux).
//
// Crashpad's POSIX snapshot sets exception_address_ = siginfo.si_addr, which
// sigaction(2) defines for SIGSEGV as the memory reference that faulted; the
// Windows snapshot sets it from EXCEPTION_RECORD.ExceptionAddress, the faulting
// instruction. The parser matched ExceptionAddress against the module ranges
// unconditionally, so on Linux it looked up the address the fault *touched*. The faulting
// instruction is in the dump — MINIDUMP_EXCEPTION_STREAM's ThreadContext at
// +160 points at a CONTEXT whose Rip is at +0xf8 (arm64 Pc at +0x108) — and was
// never read.

const STREAM_TYPE_MODULE_LIST = 4
const STREAM_TYPE_EXCEPTION = 6
const STREAM_TYPE_SYSTEM_INFO = 7

const MODULE_RECORD_SIZE = 108
const EXCEPTION_STREAM_SIZE = 168
const EXCEPTION_INFORMATION_OFFSET = 40
const EXCEPTION_THREAD_CONTEXT_OFFSET = 160
const SYSTEM_INFO_SIZE = 56
const SYSTEM_INFO_PLATFORM_ID_OFFSET = 20

// Crashpad's MinidumpOS, written to MINIDUMP_SYSTEM_INFO.PlatformId.
const PLATFORM_ID = { windows: 2, macos: 0x8101, linux: 0x8201 } as const
type Platform = keyof typeof PLATFORM_ID

// arm64Breakpad is MD_CPU_ARCHITECTURE_ARM64_OLD, the pre-standard selector.
const CPU_ARCHITECTURE = {
  amd64: 9,
  arm64: 12,
  arm64Breakpad: 0x8003
} as const
type Architecture = keyof typeof CPU_ARCHITECTURE

/** Per-architecture CONTEXT shape: total bytes, ContextFlags, and the IP slot. */
const CONTEXT_SHAPES = {
  amd64: {
    bytes: 1232,
    flagsOffset: 0x30,
    flags: 0x0010000f,
    pointerOffset: 0xf8
  },
  arm64: {
    bytes: 912,
    flagsOffset: 0,
    flags: 0x00400003,
    pointerOffset: 0x108
  },
  // MDRawContextARM64_Old: u64 context_flags then iregs[33], so Pc (iregs[32])
  // still lands at 0x108. MD_CONTEXT_ARM64_ALL_OLD is INTEGER_OLD|FLOATING_POINT_OLD
  // = 0x80000006 — the _OLD family defines no CONTROL bit at all.
  arm64Breakpad: {
    bytes: 796,
    flagsOffset: 0,
    flags: 0x80000006,
    pointerOffset: 0x108
  }
} as const

type DumpModule = { base: bigint; size: number; path: string }

/** Appends regions after the header+directory and references them by RVA, as Crashpad emits. */
class DumpBuilder {
  private readonly regions: Buffer[] = []
  private cursor: number

  constructor(private readonly prefixBytes: number) {
    this.cursor = prefixBytes
  }

  append(buf: Buffer): number {
    const rva = this.cursor
    this.regions.push(buf)
    this.cursor += buf.length
    return rva
  }

  /** MINIDUMP_STRING: u32 byte length, then UTF-16LE, NUL-terminated. */
  utf16String(value: string): number {
    const data = Buffer.from(value, 'utf16le')
    const buf = Buffer.alloc(4 + data.length + 2)
    buf.writeUInt32LE(data.length, 0)
    data.copy(buf, 4)
    return this.append(buf)
  }

  build(streams: { type: number; size: number; rva: number }[]): Buffer {
    const header = Buffer.alloc(32)
    header.writeUInt32LE(0x504d444d, 0) // 'MDMP'
    header.writeUInt32LE(0xa793, 4)
    header.writeUInt32LE(streams.length, 8)
    header.writeUInt32LE(32, 12)
    const directory = Buffer.alloc(streams.length * 12)
    streams.forEach((stream, index) => {
      directory.writeUInt32LE(stream.type, index * 12)
      directory.writeUInt32LE(stream.size, index * 12 + 4)
      directory.writeUInt32LE(stream.rva, index * 12 + 8)
    })
    const prefix = Buffer.concat([header, directory])
    expect(prefix.length).toBe(this.prefixBytes)
    return Buffer.concat([prefix, ...this.regions])
  }
}

type DumpOptions = {
  modules: DumpModule[]
  /** POSIX signal number or Win32 status code. */
  exceptionCode: number
  /** si_addr on POSIX, the faulting instruction on Windows. */
  exceptionAddress: bigint
  /** Omitted entirely for a dump with no thread context, as pre-Crashpad producers emit. */
  context?: {
    architecture: Architecture
    instructionPointer: bigint
    /** Overrides the size the ThreadContext location descriptor declares. */
    declaredSize?: number
    /** Overrides how many context bytes are actually present in the file. */
    presentBytes?: number
    /** Overrides the shape's default ContextFlags. */
    flags?: number
    /**
     * u32 at context offset 0 — context_flags in both arm64 layouts, but
     * P1Home (uninitialised home space) in CONTEXT_AMD64.
     */
    leadingWord?: number
    /**
     * u64 at +0x108 — the arm64 Pc slot, which in CONTEXT_AMD64 is inside the
     * floating-point save area (Rip is at 0xf8, the FP union starts at 0x100).
     */
    arm64PcSlot?: bigint
  }
  /** MINIDUMP_SYSTEM_INFO architecture; omitted to test the no-system-info path. */
  systemInfo?: Architecture
  /** MINIDUMP_SYSTEM_INFO.PlatformId; omitted to test the unknown-platform path. */
  platform?: Platform
  /** MINIDUMP_EXCEPTION.ExceptionInformation[0..n]. */
  exceptionInformation?: bigint[]
  /** Overrides the size the MINIDUMP_SYSTEM_INFO stream directory declares. */
  systemInfoDeclaredSize?: number
}

function buildDump(options: DumpOptions): Buffer {
  const hasSystemInfo = Boolean(options.systemInfo || options.platform)
  const streamCount = 2 + (hasSystemInfo ? 1 : 0)
  const builder = new DumpBuilder(32 + streamCount * 12)
  const streams: { type: number; size: number; rva: number }[] = []

  if (hasSystemInfo) {
    const systemInfo = Buffer.alloc(SYSTEM_INFO_SIZE)
    if (options.systemInfo) {
      systemInfo.writeUInt16LE(CPU_ARCHITECTURE[options.systemInfo], 0)
    }
    if (options.platform) {
      systemInfo.writeUInt32LE(PLATFORM_ID[options.platform], SYSTEM_INFO_PLATFORM_ID_OFFSET)
    }
    streams.push({
      type: STREAM_TYPE_SYSTEM_INFO,
      size: options.systemInfoDeclaredSize ?? SYSTEM_INFO_SIZE,
      rva: builder.append(systemInfo)
    })
  }

  const nameRvas = options.modules.map((module) => builder.utf16String(module.path))
  const listBuf = Buffer.alloc(4 + options.modules.length * MODULE_RECORD_SIZE)
  listBuf.writeUInt32LE(options.modules.length, 0)
  options.modules.forEach((module, index) => {
    const at = 4 + index * MODULE_RECORD_SIZE
    listBuf.writeBigUInt64LE(module.base, at) // BaseOfImage
    listBuf.writeUInt32LE(module.size, at + 8) // SizeOfImage
    listBuf.writeUInt32LE(nameRvas[index], at + 20) // ModuleNameRva
  })
  streams.push({
    type: STREAM_TYPE_MODULE_LIST,
    size: listBuf.length,
    rva: builder.append(listBuf)
  })

  const exceptionBuf = Buffer.alloc(EXCEPTION_STREAM_SIZE)
  exceptionBuf.writeUInt32LE(4242, 0) // ThreadId
  exceptionBuf.writeUInt32LE(options.exceptionCode, 8) // ExceptionCode
  exceptionBuf.writeBigUInt64LE(options.exceptionAddress, 24) // ExceptionAddress
  const parameters = options.exceptionInformation ?? []
  exceptionBuf.writeUInt32LE(parameters.length, 32) // NumberParameters
  parameters.forEach((parameter, index) => {
    exceptionBuf.writeBigUInt64LE(parameter, EXCEPTION_INFORMATION_OFFSET + index * 8)
  })

  if (options.context) {
    const shape = CONTEXT_SHAPES[options.context.architecture]
    const context = Buffer.alloc(shape.bytes)
    context.writeUInt32LE(options.context.flags ?? shape.flags, shape.flagsOffset)
    context.writeBigUInt64LE(options.context.instructionPointer, shape.pointerOffset)
    if (options.context.arm64PcSlot !== undefined) {
      context.writeBigUInt64LE(options.context.arm64PcSlot, 0x108)
    }
    if (options.context.leadingWord !== undefined) {
      context.writeUInt32LE(options.context.leadingWord, 0)
    }
    const contextRva = builder.append(
      context.subarray(0, options.context.presentBytes ?? shape.bytes)
    )
    exceptionBuf.writeUInt32LE(
      options.context.declaredSize ?? shape.bytes,
      EXCEPTION_THREAD_CONTEXT_OFFSET
    )
    exceptionBuf.writeUInt32LE(contextRva, EXCEPTION_THREAD_CONTEXT_OFFSET + 4)
  }

  streams.push({
    type: STREAM_TYPE_EXCEPTION,
    size: exceptionBuf.length,
    rva: builder.append(exceptionBuf)
  })

  return builder.build(streams)
}

const ORCA_BASE = 0x55e1c2a00000n
const ORCA_SIZE = 0x0a000000
const RIP_OFFSET = 0x134c608n
// Verbatim from report 6c1f4289: a PartitionAlloc/V8-cage-shaped data pointer,
// outside every ELF load range (PIE at 0x55xx…, shared objects at 0x7fxx…).
const REPORTED_SI_ADDR = 0x31b58e9fc608n

const LINUX_MODULES: DumpModule[] = [
  { base: ORCA_BASE, size: ORCA_SIZE, path: '/opt/Orca/orca' },
  {
    base: 0x7f3a1c000000n,
    size: 0x200000,
    path: '/usr/lib/x86_64-linux-gnu/libc.so.6'
  }
]

const WINDOWS_MODULES: DumpModule[] = [
  {
    base: 0x7ff629_1a0000n,
    size: 0x0a000000,
    path: 'C:\\Program Files\\Orca\\Orca.exe'
  },
  {
    base: 0x7ffc12_000000n,
    size: 0x100000,
    path: 'C:\\Windows\\System32\\ntdll.dll'
  }
]
const WIN_FAULT_ADDRESS = 0x7ff62adde94an // report-verbatim: Orca.exe+0x1c3e94a
const STATUS_ACCESS_VIOLATION = 0xc0000005
const STATUS_IN_PAGE_ERROR = 0xc0000006

describe('Linux minidump faulting-module resolution', () => {
  it('parses the Linux MINIDUMP_MODULE_LIST correctly (the walk is not PE-only)', () => {
    // Control: when the address handed to the lookup IS an instruction address,
    // the ELF module resolves. So neither MODULE_LIST parsing nor the range
    // match is the defect.
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: ORCA_BASE + RIP_OFFSET,
      context: {
        architecture: 'amd64',
        instructionPointer: ORCA_BASE + RIP_OFFSET
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('orca')
    expect(signature?.faultingModuleOffset).toBe('0x134c608')
  })

  it('si_addr alone resolves nothing — the gap, reproduced with no thread context', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: REPORTED_SI_ADDR
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.exceptionCode).toBe(0xb)
    expect(signature?.exceptionAddress).toBe('0x31b58e9fc608')
    expect(signature?.instructionPointer).toBeUndefined()
    expect(signature?.faultingModule).toBeUndefined()
  })

  it('recovers the faulting module from the thread context RIP', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: REPORTED_SI_ADDR,
      systemInfo: 'amd64',
      context: {
        architecture: 'amd64',
        instructionPointer: ORCA_BASE + RIP_OFFSET
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('orca')
    expect(signature?.faultingModuleOffset).toBe('0x134c608')
    // si_addr is real information (it IS the faulting data address); it stays.
    expect(signature?.exceptionAddress).toBe('0x31b58e9fc608')
    expect(signature?.instructionPointer).toBe('0x55e1c3d4c608')
  })

  // Same bundle (submission xjAexdQDFZnRLSZECj3ETw), reports 7040cec8 and
  // 40120f54: two more v1.4.200 Linux renderer crashes, exit 133 SIGTRAP —
  // Chromium's IMMEDIATE_CRASH(). si_addr is undefined for SIGTRAP, so Crashpad
  // wrote 0x0 and the address field carries no information at all.
  // Caveat: an int3 trap frame's RIP points one byte PAST the trapping
  // instruction, so the offset is a disassembly starting point, not the exact
  // faulting byte. Module attribution is unaffected.
  it('resolves a Linux SIGTRAP whose si_addr is 0x0, leaving RIP the only locator', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0x5,
      exceptionAddress: 0x0n,
      systemInfo: 'amd64',
      context: {
        architecture: 'amd64',
        instructionPointer: ORCA_BASE + RIP_OFFSET
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.exceptionCode).toBe(0x5)
    expect(signature?.exceptionAddress).toBe('0x0')
    expect(signature?.faultingModule).toBe('orca')
  })

  it('never invents an instruction pointer when the context reports 0x0', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0x5,
      exceptionAddress: 0x0n,
      systemInfo: 'amd64',
      context: { architecture: 'amd64', instructionPointer: 0x0n }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.instructionPointer).toBeUndefined()
    expect(signature?.faultingModule).toBeUndefined()
  })
})

// Adversarial review: si_addr is not confined to unmapped memory. A store
// through a bad pointer into a shared object's read-only page (SEGV_ACCERR) puts
// it squarely inside that image, as do SIGBUS on an mmap'ed module page and
// SEGV_PKUERR; Crashpad's Mach snapshot has the same shape, writing code[1] —
// the inaccessible data address — for EXC_BAD_ACCESS. So matching it against
// module ranges does not merely fail to resolve: it resolves to the wrong
// module, and `Faulting module: libc.so.6+0x1234` headlines a libc frame that
// never executed. Only an instruction address may name a faulting module.
describe('a data address never names a faulting module', () => {
  // Inside libc's image (base 0x7f3a1c000000, size 0x200000).
  const SI_ADDR_IN_LIBC = 0x7f3a1c001234n
  // A V8 JIT page: real code, in no mapped module.
  const JIT_INSTRUCTION_POINTER = 0x2f1a00001000n

  it('reports the JIT instruction pointer and no module, not libc from si_addr', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: SI_ADDR_IN_LIBC,
      systemInfo: 'amd64',
      platform: 'linux',
      context: {
        architecture: 'amd64',
        instructionPointer: JIT_INSTRUCTION_POINTER
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.instructionPointer).toBe('0x2f1a00001000')
    expect(signature?.exceptionAddress).toBe('0x7f3a1c001234')
    expect(signature?.faultingModule).toBeUndefined()
    expect(signature?.faultingModuleOffset).toBeUndefined()
  })

  it('stays blank on Linux when there is no context to fall back from', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: SI_ADDR_IN_LIBC,
      systemInfo: 'amd64',
      platform: 'linux'
    })

    expect(parseMinidumpCrashSignature(dump)?.faultingModule).toBeUndefined()
  })

  it('stays blank for a Mach EXC_BAD_ACCESS, whose address is code[1]', () => {
    const dump = buildDump({
      modules: [
        {
          base: 0x1a0_0000_0000n,
          size: 0x0a000000,
          path: '/Applications/Orca.app/MacOS/Orca'
        }
      ],
      exceptionCode: 1, // EXC_BAD_ACCESS
      exceptionAddress: 0x1a0_0000_04c8n,
      systemInfo: 'arm64',
      platform: 'macos'
    })

    expect(parseMinidumpCrashSignature(dump)?.faultingModule).toBeUndefined()
  })

  // A dump that does not say it is Windows is not assumed to be.
  it('stays blank when the dump declares no platform at all', () => {
    const dump = buildDump({
      modules: WINDOWS_MODULES,
      exceptionCode: STATUS_ACCESS_VIOLATION,
      exceptionAddress: WIN_FAULT_ADDRESS
    })

    expect(parseMinidumpCrashSignature(dump)?.faultingModule).toBeUndefined()
  })

  it('ignores a system-info stream too short to hold PlatformId', () => {
    // The stream is declared 16 bytes but a WIN32_NT-shaped 2 sits at +20.
    // Reading it anyway would call this SIGSEGV dump Windows and let si_addr —
    // an address inside libc — name libc as the faulting module.
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: SI_ADDR_IN_LIBC,
      platform: 'windows',
      systemInfoDeclaredSize: 16
    })

    expect(parseMinidumpCrashSignature(dump)?.faultingModule).toBeUndefined()
  })
})

// The flip side of the block above: ExceptionAddress is not a data address on
// every non-Windows dump. Crashpad's Mach snapshot only takes code[1] for
// EXC_BAD_ACCESS and otherwise sets exception_address_ from the thread
// context's instruction pointer, and sigaction(2) defines si_addr as the
// faulting *instruction* for SIGILL and SIGFPE. A platform-blanket gate would
// throw those away — including the corpus's only macOS report (v1.4.197,
// EXC_BREAKPOINT), which resolves Electron Framework+0xe8ab78 from
// ExceptionAddress alone.
describe('an instruction ExceptionAddress still names a module', () => {
  const FRAMEWORK_BASE = 0x1_0000_0000n
  const MAC_MODULES: DumpModule[] = [
    {
      base: FRAMEWORK_BASE,
      size: 0x0200_0000,
      path: '/Applications/Orca.app/Contents/Frameworks/Electron Framework.framework/Electron Framework'
    }
  ]

  it('resolves a Mach EXC_BREAKPOINT from ExceptionAddress with no context to fall back on', () => {
    const dump = buildDump({
      modules: MAC_MODULES,
      exceptionCode: 0x6, // EXC_BREAKPOINT
      exceptionAddress: FRAMEWORK_BASE + 0xe8ab78n,
      systemInfo: 'arm64',
      platform: 'macos'
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('Electron Framework')
    expect(signature?.faultingModuleOffset).toBe('0xe8ab78')
  })

  it.each([
    ['SIGILL', 0x4],
    ['SIGFPE', 0x8]
  ])('resolves a Linux %s, whose si_addr is the faulting instruction', (_name, code) => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: code,
      exceptionAddress: ORCA_BASE + RIP_OFFSET,
      systemInfo: 'amd64',
      platform: 'linux'
    })

    expect(parseMinidumpCrashSignature(dump)?.faultingModule).toBe('orca')
  })

  it('still prefers the context over si_addr for SIGILL when both are present', () => {
    // si_addr and Rip agree in practice; if a producer disagrees, the register
    // the CPU actually faulted on wins.
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0x4,
      exceptionAddress: 0x7f3a1c001234n, // inside libc
      systemInfo: 'amd64',
      platform: 'linux',
      context: { architecture: 'amd64', instructionPointer: ORCA_BASE + RIP_OFFSET }
    })

    expect(parseMinidumpCrashSignature(dump)?.faultingModule).toBe('orca')
  })

  it('attributes nothing for a Linux SIGTRAP, whose si_addr is undefined', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0x5,
      exceptionAddress: ORCA_BASE + RIP_OFFSET, // plausible-looking, still not si_addr
      systemInfo: 'amd64',
      platform: 'linux'
    })

    expect(parseMinidumpCrashSignature(dump)?.faultingModule).toBeUndefined()
  })
})

describe('instruction pointer across architectures', () => {
  const ARM64_BASE = 0x1a0_0000_0000n
  const ARM64_MODULES: DumpModule[] = [
    {
      base: ARM64_BASE,
      size: 0x0a000000,
      path: '/Applications/Orca.app/Contents/MacOS/Orca'
    }
  ]

  it('reads Pc at +0x108 from an arm64 context (Apple Silicon, arm64 Linux)', () => {
    const dump = buildDump({
      modules: ARM64_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: REPORTED_SI_ADDR,
      systemInfo: 'arm64',
      context: {
        architecture: 'arm64',
        instructionPointer: ARM64_BASE + 0x4c8n
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.instructionPointer).toBe('0x1a0000004c8')
    expect(signature?.faultingModule).toBe('Orca')
    expect(signature?.faultingModuleOffset).toBe('0x4c8')
  })

  // The lower edge of the arm64 byte window: Crashpad's MinidumpContextARM64 is
  // exactly 792 bytes, which is what a real Apple Silicon or arm64 Linux dump
  // declares. Windows' 912-byte ARM64_NT_CONTEXT is the upper edge, above.
  it('reads Pc from a 792-byte Crashpad arm64 context', () => {
    const dump = buildDump({
      modules: ARM64_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: REPORTED_SI_ADDR,
      systemInfo: 'arm64',
      context: {
        architecture: 'arm64',
        instructionPointer: ARM64_BASE + 0x4c8n,
        declaredSize: 792,
        presentBytes: 792
      }
    })

    expect(parseMinidumpCrashSignature(dump)?.faultingModule).toBe('Orca')
  })

  // Breakpad's legacy arm64 context is a different struct reached by a different
  // flag: MD_CONTEXT_ARM64_OLD is 0x80000000, i.e. bit 31. A `flags & selector`
  // comparison against it is an int32 compare that can never equal the unsigned
  // selector, so this whole family silently lost its instruction pointer.
  it('reads Pc from a Breakpad-legacy arm64 context (bit-31 selector, no CONTROL bit)', () => {
    const dump = buildDump({
      modules: ARM64_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: REPORTED_SI_ADDR,
      systemInfo: 'arm64Breakpad',
      context: {
        architecture: 'arm64Breakpad',
        instructionPointer: ARM64_BASE + 0x4c8n
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.instructionPointer).toBe('0x1a0000004c8')
    expect(signature?.faultingModule).toBe('Orca')
  })

  it('reads a Breakpad-legacy arm64 context under the modern arch id and with no system info', () => {
    for (const systemInfo of ['arm64', undefined] as const) {
      const dump = buildDump({
        modules: ARM64_MODULES,
        exceptionCode: 0xb,
        exceptionAddress: REPORTED_SI_ADDR,
        ...(systemInfo ? { systemInfo } : {}),
        context: {
          architecture: 'arm64Breakpad',
          instructionPointer: ARM64_BASE + 0x4c8n
        }
      })

      expect(parseMinidumpCrashSignature(dump)?.instructionPointer).toBe('0x1a0000004c8')
    }
  })

  // Pc is iregs[32] in the legacy struct, so the integer group — not a control
  // group the _OLD family never defined — is what says it is populated.
  it('skips a Breakpad-legacy arm64 context that omits the integer register group', () => {
    const dump = buildDump({
      modules: ARM64_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: REPORTED_SI_ADDR,
      systemInfo: 'arm64Breakpad',
      context: {
        architecture: 'arm64Breakpad',
        instructionPointer: ARM64_BASE + 0x4c8n,
        // FLOATING_POINT_OLD alone: the iregs array is not populated.
        flags: 0x80000004
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.instructionPointer).toBeUndefined()
    expect(signature?.faultingModule).toBeUndefined()
  })

  it('still reads an arm64 context when the dump carries no system-info stream', () => {
    const dump = buildDump({
      modules: ARM64_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: 0x0n,
      context: {
        architecture: 'arm64',
        instructionPointer: ARM64_BASE + 0x4c8n
      }
    })

    expect(parseMinidumpCrashSignature(dump)?.faultingModule).toBe('Orca')
  })

  it('skips a context the system-info architecture disagrees with', () => {
    // An amd64 CONTEXT under an arm64 system info: reading Pc at +0x108 would
    // hand back a float-save-area word. The system info rules the amd64 layout
    // out, so what rejects the arm64 layouts is the context's size — and it has
    // to, because P1Home (where they read context_flags) is uninitialised
    // home space, not a zeroed field, so it is set here to the exact bits that
    // would wave the context through.
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: REPORTED_SI_ADDR,
      systemInfo: 'arm64',
      context: {
        architecture: 'amd64',
        instructionPointer: ORCA_BASE + RIP_OFFSET,
        leadingWord: 0x00400001, // CONTEXT_ARM64 | CONTEXT_ARM64_CONTROL
        arm64PcSlot: ORCA_BASE + RIP_OFFSET
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.instructionPointer).toBeUndefined()
    expect(signature?.faultingModule).toBeUndefined()
  })

  it('skips a context whose declared size is too short to be one', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: REPORTED_SI_ADDR,
      systemInfo: 'amd64',
      context: {
        architecture: 'amd64',
        instructionPointer: ORCA_BASE + RIP_OFFSET,
        declaredSize: 256
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.instructionPointer).toBeUndefined()
    expect(signature?.faultingModule).toBeUndefined()
  })

  // A layout whose CONTEXT_<arch> selector matched owns the context: re-reading
  // the same bytes under the next layout's struct would hand back a foreign
  // register. CONTEXT_AMD64's P1Home sits exactly where the arm64 layouts read
  // context_flags, so an uninitialised home-space slot can masquerade as one.
  it('does not re-read an amd64 context whose Rip is 0 as an arm64 one', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0x5,
      exceptionAddress: 0x0n,
      // No system-info stream, so nothing narrows the candidate layouts.
      context: {
        architecture: 'amd64',
        instructionPointer: 0x0n,
        // CONTEXT_ARM64 | CONTEXT_ARM64_CONTROL, as the arm64 layout reads it.
        leadingWord: 0x00400001,
        arm64PcSlot: ORCA_BASE + RIP_OFFSET
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.instructionPointer).toBeUndefined()
    expect(signature?.faultingModule).toBeUndefined()
  })

  // ...and the same when ContextFlags does not name amd64 either, so the amd64
  // layout declines the context rather than owning it. A partially written or
  // foreign-producer context reads back as flags 0; the layouts' byte windows
  // are what keep the arm64 structs off a 1232-byte record.
  it('does not re-read an amd64-sized context with cleared ContextFlags as an arm64 one', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0x5,
      exceptionAddress: 0x0n,
      // No system-info stream, so nothing narrows the candidate layouts.
      context: {
        architecture: 'amd64',
        instructionPointer: ORCA_BASE + RIP_OFFSET,
        flags: 0,
        leadingWord: 0x00400001,
        arm64PcSlot: ORCA_BASE + RIP_OFFSET
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.instructionPointer).toBeUndefined()
    expect(signature?.faultingModule).toBeUndefined()
  })

  // A zeroed or truncated MINIDUMP_SYSTEM_INFO reads back as architecture 0
  // (PROCESSOR_ARCHITECTURE_INTEL). Trusting that would be strictly worse than
  // the no-system-info dump above, which still recovers Rip.
  it('falls back to size and flags when system info names an architecture it does not decode', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: REPORTED_SI_ADDR,
      platform: 'linux', // system-info stream present, ProcessorArchitecture left 0
      context: { architecture: 'amd64', instructionPointer: ORCA_BASE + RIP_OFFSET }
    })

    expect(parseMinidumpCrashSignature(dump)?.faultingModule).toBe('orca')
  })

  it('degrades instead of throwing when a full-size context is cut off by the file end', () => {
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: REPORTED_SI_ADDR,
      systemInfo: 'amd64',
      context: {
        architecture: 'amd64',
        instructionPointer: ORCA_BASE + RIP_OFFSET,
        presentBytes: 0x40
      }
    })

    expect(() => parseMinidumpCrashSignature(dump)).not.toThrow()
    expect(parseMinidumpCrashSignature(dump)?.instructionPointer).toBeUndefined()
  })
})

describe('Windows keeps attributing from ExceptionAddress', () => {
  it('resolves from ExceptionAddress when the dump has no thread context', () => {
    const dump = buildDump({
      modules: WINDOWS_MODULES,
      exceptionCode: STATUS_ACCESS_VIOLATION,
      exceptionAddress: WIN_FAULT_ADDRESS,
      platform: 'windows'
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('Orca.exe')
    expect(signature?.faultingModuleOffset).toBe('0x1c3e94a')
  })

  it('resolves the same module when the context Rip matches ExceptionAddress', () => {
    const dump = buildDump({
      modules: WINDOWS_MODULES,
      exceptionCode: STATUS_ACCESS_VIOLATION,
      exceptionAddress: WIN_FAULT_ADDRESS,
      systemInfo: 'amd64',
      platform: 'windows',
      context: { architecture: 'amd64', instructionPointer: WIN_FAULT_ADDRESS }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('Orca.exe')
    expect(signature?.faultingModuleOffset).toBe('0x1c3e94a')
    expect(signature?.exceptionAddress).toBe('0x7ff62adde94a')
  })

  // The shape every real Crashpad dump has: MinidumpExceptionWriter always
  // emits a ThreadContext, so the context is present on all 45 resolving Win64
  // reports. Windows defines ExceptionAddress as the faulting instruction for
  // every exception class, so it stays the attribution source and the offsets
  // already filed keep matching.
  it('attributes from ExceptionAddress, not the context Rip, when the two differ', () => {
    const dump = buildDump({
      modules: WINDOWS_MODULES,
      exceptionCode: 0x80000003, // STATUS_BREAKPOINT: a Chromium IMMEDIATE_CRASH
      exceptionAddress: WIN_FAULT_ADDRESS,
      systemInfo: 'amd64',
      platform: 'windows',
      context: { architecture: 'amd64', instructionPointer: WIN_FAULT_ADDRESS + 1n }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('Orca.exe')
    expect(signature?.faultingModuleOffset).toBe('0x1c3e94a')
    expect(signature?.instructionPointer).toBe('0x7ff62adde94b')
  })

  // Crashpad writes 0x0 when it captures a Windows process with no exception
  // pointers; the context is then the only locator left.
  it('falls back to the context Rip when ExceptionAddress is 0x0', () => {
    const dump = buildDump({
      modules: WINDOWS_MODULES,
      exceptionCode: STATUS_ACCESS_VIOLATION,
      exceptionAddress: 0x0n,
      systemInfo: 'amd64',
      platform: 'windows',
      context: { architecture: 'amd64', instructionPointer: WIN_FAULT_ADDRESS }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.exceptionAddress).toBe('0x0')
    expect(signature?.faultingModule).toBe('Orca.exe')
    expect(signature?.faultingModuleOffset).toBe('0x1c3e94a')
  })

  // The renderer use-after-free family (v1.4.197–v1.4.199) is all
  // STATUS_ACCESS_VIOLATION; read-vs-write and the inaccessible address are what
  // separate a null deref from a wild pointer.
  it('captures ExceptionInformation[0]/[1] on an access violation', () => {
    const dump = buildDump({
      modules: WINDOWS_MODULES,
      exceptionCode: STATUS_ACCESS_VIOLATION,
      exceptionAddress: WIN_FAULT_ADDRESS,
      platform: 'windows',
      exceptionInformation: [1n, 0x1n]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.accessKind).toBe('write')
    expect(signature?.accessAddress).toBe('0x1')
  })

  it('reports a DEP execute fault, and keeps the address when the kind is unknown', () => {
    const execute = parseMinidumpCrashSignature(
      buildDump({
        modules: WINDOWS_MODULES,
        exceptionCode: STATUS_ACCESS_VIOLATION,
        exceptionAddress: WIN_FAULT_ADDRESS,
        platform: 'windows',
        exceptionInformation: [8n, 0x2b0000n]
      })
    )
    expect(execute?.accessKind).toBe('execute')
    expect(execute?.accessAddress).toBe('0x2b0000')

    const unknown = parseMinidumpCrashSignature(
      buildDump({
        modules: WINDOWS_MODULES,
        exceptionCode: STATUS_ACCESS_VIOLATION,
        exceptionAddress: WIN_FAULT_ADDRESS,
        platform: 'windows',
        exceptionInformation: [99n, 0x2b0000n]
      })
    )
    expect(unknown?.accessKind).toBeUndefined()
    expect(unknown?.accessAddress).toBe('0x2b0000')
  })

  it('reports no access kind when the record declares fewer than two parameters', () => {
    // A zeroed ExceptionInformation array would otherwise read as a confident
    // `read` of 0x0 — a null deref the dump never claimed.
    const dump = buildDump({
      modules: WINDOWS_MODULES,
      exceptionCode: STATUS_ACCESS_VIOLATION,
      exceptionAddress: WIN_FAULT_ADDRESS,
      platform: 'windows',
      exceptionInformation: [0n]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.accessKind).toBeUndefined()
    expect(signature?.accessAddress).toBeUndefined()
    expect(signature?.faultingModule).toBe('Orca.exe')
  })

  it('captures the access record of an in-page error too', () => {
    const dump = buildDump({
      modules: WINDOWS_MODULES,
      exceptionCode: STATUS_IN_PAGE_ERROR,
      exceptionAddress: WIN_FAULT_ADDRESS,
      platform: 'windows',
      exceptionInformation: [0n, 0x2b0000n]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.accessKind).toBe('read')
    expect(signature?.accessAddress).toBe('0x2b0000')
  })

  it('does not read ExceptionInformation as an access kind on a POSIX signal', () => {
    // Crashpad's POSIX writer puts si_code in the same slot; 2 would decode as a
    // bogus access kind and si_code-adjacent data as a bogus address.
    const dump = buildDump({
      modules: LINUX_MODULES,
      exceptionCode: 0xb,
      exceptionAddress: REPORTED_SI_ADDR,
      platform: 'linux',
      exceptionInformation: [1n, 0x31b58e9fc608n]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.accessKind).toBeUndefined()
    expect(signature?.accessAddress).toBeUndefined()
  })

  it('surfaces the new fields as details a report reader can see', () => {
    const dump = buildDump({
      modules: WINDOWS_MODULES,
      exceptionCode: STATUS_ACCESS_VIOLATION,
      exceptionAddress: WIN_FAULT_ADDRESS,
      systemInfo: 'amd64',
      platform: 'windows',
      context: { architecture: 'amd64', instructionPointer: WIN_FAULT_ADDRESS },
      exceptionInformation: [0n, 0x0n]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(minidumpSignatureDetails(signature!)).toMatchObject({
      minidumpExceptionAddress: '0x7ff62adde94a',
      minidumpInstructionPointer: '0x7ff62adde94a',
      minidumpAccessKind: 'read',
      minidumpAccessAddress: '0x0',
      minidumpFaultingModule: 'Orca.exe'
    })
  })
})
