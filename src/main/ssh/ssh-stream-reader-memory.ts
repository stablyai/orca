export const STREAM_READER_INACTIVITY_TIMEOUT_MS = 30_000
export const MAX_PRE_METADATA_STREAM_FRAMES = 64
export const MAX_PRE_METADATA_STREAM_ENCODED_BYTES = 8 * 1024 * 1024
export const MAX_SSH_PRE_METADATA_STREAM_FRAMES = 256
export const MAX_SSH_PRE_METADATA_STREAM_RETAINED_BYTES = 32 * 1024 * 1024
export const MAX_SSH_STREAM_ASSEMBLY_BYTES = 128 * 1024 * 1024

export type BufferedStreamFrame = {
  kind: 'chunk' | 'end' | 'error'
  params: Record<string, unknown>
}

type RetainedStreamFrame = {
  frame: BufferedStreamFrame
  encodedBytes: number
  release: () => void
}

export class SshPreMetadataStreamBudget {
  private frames = 0
  private bytes = 0

  constructor(
    readonly maxFrames: number,
    readonly maxBytes: number
  ) {}

  reserve(bytes: number): (() => void) | null {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.frames >= this.maxFrames ||
      bytes > this.maxBytes - this.bytes
    ) {
      return null
    }
    this.frames += 1
    this.bytes += bytes
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.frames -= 1
      this.bytes -= bytes
    }
  }

  get retainedFrames(): number {
    return this.frames
  }

  get retainedBytes(): number {
    return this.bytes
  }
}

export const defaultSshPreMetadataStreamBudget = new SshPreMetadataStreamBudget(
  MAX_SSH_PRE_METADATA_STREAM_FRAMES,
  MAX_SSH_PRE_METADATA_STREAM_RETAINED_BYTES
)

export class PreMetadataStreamFrameBuffer {
  private frames: RetainedStreamFrame[] = []
  private encodedBytes = 0

  constructor(private readonly budget: SshPreMetadataStreamBudget) {}

  push(frame: BufferedStreamFrame): boolean {
    const retainedFrame = retainStreamFrameFields(frame)
    const frameBytes = retainedStreamFrameBytes(retainedFrame)
    if (frameBytes > MAX_PRE_METADATA_STREAM_ENCODED_BYTES) {
      return false
    }
    while (
      this.frames.length >= MAX_PRE_METADATA_STREAM_FRAMES ||
      this.encodedBytes + frameBytes > MAX_PRE_METADATA_STREAM_ENCODED_BYTES
    ) {
      this.shift()
    }
    let release = this.budget.reserve(frameBytes)
    while (!release && this.frames.length > 0) {
      this.shift()
      release = this.budget.reserve(frameBytes)
    }
    if (!release) {
      return false
    }
    this.frames.push({ frame: retainedFrame, encodedBytes: frameBytes, release })
    this.encodedBytes += frameBytes
    return true
  }

  shift(): BufferedStreamFrame | undefined {
    const retained = this.frames.shift()
    if (retained) {
      this.encodedBytes -= retained.encodedBytes
      retained.release()
    }
    return retained?.frame
  }

  get length(): number {
    return this.frames.length
  }

  clear(): void {
    while (this.frames.length > 0) {
      this.shift()
    }
  }
}

function retainStreamFrameFields(frame: BufferedStreamFrame): BufferedStreamFrame {
  const { params } = frame
  if (frame.kind === 'chunk') {
    return {
      kind: frame.kind,
      params: {
        ...(typeof params.streamId === 'number' ? { streamId: params.streamId } : {}),
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        ...(typeof params.data === 'string' ? { data: params.data } : {})
      }
    }
  }
  if (frame.kind === 'error') {
    return {
      kind: frame.kind,
      params: {
        ...(typeof params.streamId === 'number' ? { streamId: params.streamId } : {}),
        ...(typeof params.message === 'string' ? { message: params.message } : {}),
        ...(typeof params.code === 'string' ? { code: params.code } : {})
      }
    }
  }
  return {
    kind: frame.kind,
    params: typeof params.streamId === 'number' ? { streamId: params.streamId } : {}
  }
}

function retainedStreamFrameBytes(frame: BufferedStreamFrame): number {
  let bytes = 0
  for (const value of Object.values(frame.params)) {
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf-8')
    }
  }
  return bytes
}

export class SshStreamAssemblyBudget {
  private retained = 0

  constructor(readonly maxBytes: number) {}

  reserve(bytes: number): (() => void) | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes - this.retained) {
      return null
    }
    this.retained += bytes
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.retained -= bytes
    }
  }

  get retainedBytes(): number {
    return this.retained
  }
}

export const defaultSshStreamAssemblyBudget = new SshStreamAssemblyBudget(
  MAX_SSH_STREAM_ASSEMBLY_BYTES
)

export function base64EncodedLength(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4
}

export function createStreamInactivityDeadline(
  timeoutMs: number,
  onTimeout: () => void
): { reset: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  return {
    reset: () => {
      clear()
      timer = setTimeout(onTimeout, timeoutMs)
      timer.unref?.()
    },
    clear
  }
}
