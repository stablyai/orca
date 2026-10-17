import bridgePath from '../../../resources/notebook/kernel-bridge.py?asset&asarUnpack'
import { spawnProcess } from '@orca/process-host'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import { createNdjsonParser } from '../../shared/main-process-ndjson-framer'
import {
  KERNEL_OUTPUT_TYPES,
  type KernelFrame,
  type KernelIpcFrame,
  type KernelOutputFrame,
  type KernelStartResult
} from '../../shared/notebook-kernel-types'

const STDERR_TAIL_CHARS = 4000
const SHUTDOWN_GRACE_MS = 5000
const OUTPUT_BATCH_MS = 10

type BridgeFrame = KernelFrame | { type: 'ready' } | { type: 'missing'; externallyManaged: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFrame(value: unknown): BridgeFrame | null {
  if (!isRecord(value)) {
    return null
  }
  const { type, content } = value
  if (type === 'ready') {
    return { type }
  }
  if (type === 'missing') {
    return { type, externallyManaged: value.externallyManaged === true }
  }
  if (type === 'done') {
    return {
      type,
      status: String(value.status),
      execution_count: typeof value.execution_count === 'number' ? value.execution_count : null
    }
  }
  const outputType = KERNEL_OUTPUT_TYPES.find((candidate) => candidate === type)
  return outputType && isRecord(content) ? { type: outputType, content } : null
}

/** Splits bridge stdout into frames, skipping any line that is not one. */
export function createFrameReader(onFrame: (frame: BridgeFrame) => void): (text: string) => void {
  // Each frame ships as its line completes; a consumer throw escapes the stdout listener and is fatal anyway.
  const parser = createNdjsonParser(
    (value) => {
      const frame = parseFrame(value)
      if (frame) {
        onFrame(frame)
      }
    },
    // The bridge keeps fd 1 to itself, so an unreadable line means the frame channel is damaged.
    (error) => console.warn('[notebook-kernel] Dropped an unreadable bridge record:', error),
    // Notebook display frames can contain large images; preserve the existing unrestricted size.
    { maxLineBytes: Number.POSITIVE_INFINITY }
  )
  return (text) => parser.feed(text)
}

/**
 * Sends output frames in batches, each 10 ms after its first frame, so a chatty cell costs one IPC
 * and one renderer update per batch. Frames retain their original boundaries so the renderer's
 * output reducer keeps its existing carriage-return semantics. `done` and `exit` send the pending
 * batch, then go on their own.
 */
export function createFrameBatcher(send: (frame: KernelIpcFrame) => void): {
  add: (frame: KernelFrame) => void
  flush: () => void
  drop: () => void
} {
  let outputs: KernelOutputFrame[] = []
  let startedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const drop = (): void => {
    clearTimeout(timer)
    timer = undefined
    outputs = []
  }
  const flush = (): void => {
    const batch = outputs
    drop()
    if (batch.length > 0) {
      send({ type: 'outputs', outputs: batch })
    }
  }
  return {
    add: (frame) => {
      if (frame.type === 'done' || frame.type === 'exit') {
        flush()
        send(frame)
        return
      }
      outputs.push(frame)
      if (timer === undefined) {
        startedAt = Date.now()
        timer = setTimeout(flush, OUTPUT_BATCH_MS)
      } else if (Date.now() - startedAt > OUTPUT_BATCH_MS) {
        // Why: one long stdout read holds the timer back, so an overdue batch goes now.
        flush()
      }
    },
    flush,
    drop
  }
}

export type NotebookKernel = {
  /** Only one execution may be in flight; send the next after its `done` frame. */
  execute: (code: string) => void
  interrupt: () => void
  /** Closing stdin is the bridge's shutdown signal; the force-kill covers a wedged bridge. */
  shutdown: (drain?: boolean) => void
}

export function startNotebookKernel({
  python,
  cwd,
  onFrame
}: {
  python: string
  cwd: string
  onFrame: (frame: KernelIpcFrame) => void
}): { kernel: NotebookKernel; ready: Promise<KernelStartResult>; exited: Promise<void> } {
  const child = spawnProcess({
    program: python,
    args: [bridgePath],
    cwd,
    detached: process.platform !== 'win32'
  })
  let settle: (result: KernelStartResult) => void = () => {}
  const ready = new Promise<KernelStartResult>((resolve) => {
    settle = resolve
  })
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  let started = false
  let stopping = false
  let stderrTail = ''
  const batcher = createFrameBatcher(onFrame)

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text: string) => {
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS)
  })
  // Why: an unhandled stream error crashes main (see spawnProcess); a write racing the bridge's
  // exit raises EPIPE, and the exit itself is reported on close.
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => {})
  }
  child.stdout.on(
    'data',
    createFrameReader((frame) => {
      if (frame.type === 'ready') {
        started = true
        // Why: a death notice should show what the kernel said since it started, not startup warnings.
        stderrTail = ''
        settle({ status: 'ready' })
      } else if (frame.type === 'missing') {
        settle({ status: 'missing-ipykernel', externallyManaged: frame.externallyManaged })
      } else if (!stopping) {
        batcher.add(frame)
      }
    })
  )
  child.once('error', (error) => settle({ status: 'failed', detail: error.message }))
  child.once('close', (code) => {
    const detail = stderrTail.trim()
    settle({ status: 'failed', detail: detail || `Python exited with code ${code}.` })
    if (started && !stopping) {
      batcher.add({ type: 'exit', detail })
    }
  })

  const send = (command: Record<string, string>): void => {
    child.stdin.write(`${JSON.stringify(command)}\n`)
  }
  return {
    ready,
    exited,
    kernel: {
      execute: (code) => send({ op: 'execute', code }),
      interrupt: () => send({ op: 'interrupt' }),
      shutdown: (drain = false) => {
        stopping = true
        try {
          if (drain) {
            batcher.flush()
            onFrame({ type: 'stopped' })
          } else {
            batcher.drop()
          }
        } finally {
          child.stdin.end()
          const forceKill = setTimeout(
            () => void forceTerminateProcessTree(child),
            SHUTDOWN_GRACE_MS
          )
          forceKill.unref()
          void exited.then(() => clearTimeout(forceKill))
        }
      }
    }
  }
}
