// Captured instruction bytes permit comparison with the shipped binary during fault triage.

import { findStream, type MinidumpView } from './minidump-stream-reader'

const STREAM_TYPE_MEMORY_LIST = 5
const EXCEPTION_ACCESS_VIOLATION = 0xc0000005

// MINIDUMP_EXCEPTION_STREAM: ThreadId, alignment, MINIDUMP_EXCEPTION (152 bytes), ThreadContext.
const NUMBER_PARAMETERS_OFFSET = 8 + 24
const EXCEPTION_INFORMATION_OFFSET = 8 + 32
const THREAD_CONTEXT_OFFSET = 8 + 152

// x64 CONTEXT; other architectures report no stack-pointer delta.
const AMD64_CONTEXT_SIZE = 0x4d0
const AMD64_CONTEXT_FLAGS_OFFSET = 0x30
const CONTEXT_AMD64 = 0x00100000
const AMD64_RSP_OFFSET = 0x98

const MEMORY_DESCRIPTOR_SIZE = 16
const MAX_MEMORY_RANGES = 16_384
const CODE_BYTES = 16
// Larger deltas add no useful evidence about the faulting stack frame.
const MAX_STACK_POINTER_DELTA = 1024 * 1024

const ACCESS_KINDS: Readonly<Record<number, MinidumpFaultContext['access']>> = {
  0: 'read',
  1: 'write',
  8: 'execute'
}

export type MinidumpFaultContext = {
  readonly access?: 'read' | 'write' | 'execute'
  readonly faultAddress?: string
  /** Fault address minus the faulting thread's stack pointer, when within 1 MiB. */
  readonly faultStackPointerDelta?: number
  /** Hex of the bytes at the instruction pointer, as captured in the dump. */
  readonly codeBytes?: string
}

async function readAmd64StackPointer(
  view: MinidumpView,
  exceptionRva: number
): Promise<bigint | null> {
  const context = await view.location(exceptionRva + THREAD_CONTEXT_OFFSET)
  if (!context || context.size < AMD64_CONTEXT_SIZE) {
    return null
  }
  const flags = await view.u32(context.rva + AMD64_CONTEXT_FLAGS_OFFSET)
  if (flags === null || (flags & CONTEXT_AMD64) === 0) {
    return null
  }
  return view.u64(context.rva + AMD64_RSP_OFFSET)
}

async function readCapturedBytes(view: MinidumpView, address: bigint): Promise<string | null> {
  const stream = await findStream(view, STREAM_TYPE_MEMORY_LIST)
  if (!stream) {
    return null
  }
  const count = await view.u32(stream.rva)
  if (count === null || count > MAX_MEMORY_RANGES) {
    return null
  }
  for (let index = 0; index < count; index += 1) {
    const descriptor = stream.rva + 4 + index * MEMORY_DESCRIPTOR_SIZE
    const start = await view.u64(descriptor)
    const range = await view.location(descriptor + 8)
    if (start === null) {
      return null
    }
    if (!range || address < start || address >= start + BigInt(range.size)) {
      continue
    }
    const skip = Number(address - start)
    const size = Math.min(CODE_BYTES, range.size - skip)
    const bytes = await view.bytes({ size, rva: range.rva + skip }, CODE_BYTES)
    return bytes ? bytes.toString('hex') : null
  }
  return null
}

export async function readMinidumpFaultContext(
  view: MinidumpView,
  exceptionRva: number,
  exceptionCode: number | null,
  exceptionAddress: bigint,
  options: { readonly captureCodeBytes: boolean }
): Promise<MinidumpFaultContext> {
  const result: { -readonly [K in keyof MinidumpFaultContext]: MinidumpFaultContext[K] } = {}
  const codeBytes = options.captureCodeBytes
    ? await readCapturedBytes(view, exceptionAddress)
    : null
  if (codeBytes) {
    result.codeBytes = codeBytes
  }
  if (exceptionCode !== EXCEPTION_ACCESS_VIOLATION) {
    return result
  }
  const parameterCount = await view.u32(exceptionRva + NUMBER_PARAMETERS_OFFSET)
  if (parameterCount === null || parameterCount < 2) {
    return result
  }
  const kind = await view.u64(exceptionRva + EXCEPTION_INFORMATION_OFFSET)
  const faultAddress = await view.u64(exceptionRva + EXCEPTION_INFORMATION_OFFSET + 8)
  const access = kind === null ? undefined : ACCESS_KINDS[Number(kind)]
  if (access) {
    result.access = access
  }
  if (faultAddress === null) {
    return result
  }
  result.faultAddress = `0x${faultAddress.toString(16)}`
  const stackPointer = await readAmd64StackPointer(view, exceptionRva)
  if (stackPointer !== null) {
    const delta = faultAddress - stackPointer
    const magnitude = delta < 0n ? -delta : delta
    if (magnitude <= BigInt(MAX_STACK_POINTER_DELTA)) {
      result.faultStackPointerDelta = Number(delta)
    }
  }
  return result
}
