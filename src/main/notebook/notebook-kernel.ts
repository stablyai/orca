import bridgePath from '../../../resources/notebook/kernel-bridge.py?asset&asarUnpack'
import { spawnProcess } from '@orca/process-host'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import { createNdjsonParser } from '../../shared/main-process-ndjson-framer'
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

export function createFrameReader(onFrame: (frame: BridgeFrame) => void): (text: string) => void {
  const parser = createNdjsonParser(
    (value) => {
      const frame = parseFrame(value)
      if (frame) {
        onFrame(frame)
      }
    },
    // The bridge owns stdout exclusively, so unreadable lines signal channel corruption.
    (error) => console.warn('[notebook-kernel] Dropped an unreadable bridge record:', error),
    // Notebook image frames retain the existing unrestricted size limit.
    { maxLineBytes: Number.POSITIVE_INFINITY }
  )
  return (text) => parser.feed(text)
}

export type NotebookKernel = {
  execute: (code: string) => void
  interrupt: () => void
  /** stdin close requests shutdown; force-kill handles a wedged bridge. */
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
  // Ignore EPIPE races during exit; close reports death, while unhandled stream errors would crash main.
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => {})
  }
  child.stdout.on(
    'data',
    createFrameReader((frame) => {
      if (frame.type === 'ready') {
        started = true
        // Report post-start diagnostics on death, excluding startup warnings.
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
