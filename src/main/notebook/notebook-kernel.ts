import bridgePath from '../../../resources/notebook/kernel-bridge.py?asset&asarUnpack'
import { spawnProcess } from '../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'
import {
  KERNEL_OUTPUT_TYPES,
  type KernelFrame,
  type KernelStartResult
} from '../../shared/notebook-kernel-types'

const STDERR_TAIL_CHARS = 4000
const SHUTDOWN_GRACE_MS = 5000

type BridgeFrame = KernelFrame | { type: 'ready' } | { type: 'missing'; externallyManaged: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFrame(line: string): BridgeFrame | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
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
  let partial = ''
  return (text) => {
    const lines = (partial + text).split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) {
      const frame = parseFrame(line)
      if (frame) {
        onFrame(frame)
      }
    }
  }
}

export type NotebookKernel = {
  /** Only one execution may be in flight; send the next after its `done` frame. */
  execute: (code: string) => void
  interrupt: () => void
  /** Closing stdin is the bridge's shutdown signal; the force-kill covers a wedged bridge. */
  shutdown: () => void
}

export function startNotebookKernel({
  python,
  cwd,
  onFrame
}: {
  python: string
  cwd: string
  onFrame: (frame: KernelFrame) => void
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
        onFrame(frame)
      }
    })
  )
  child.once('error', (error) => settle({ status: 'failed', detail: error.message }))
  child.once('close', (code) => {
    const detail = stderrTail.trim()
    settle({ status: 'failed', detail: detail || `Python exited with code ${code}.` })
    if (started && !stopping) {
      onFrame({ type: 'exit', detail })
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
      shutdown: () => {
        stopping = true
        child.stdin.end()
        const forceKill = setTimeout(() => void forceTerminateProcessTree(child), SHUTDOWN_GRACE_MS)
        forceKill.unref()
        void exited.then(() => clearTimeout(forceKill))
      }
    }
  }
}
