import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { spawnSttWorkerWithCpuFallback } from './stt-worker-cpu-fallback'

class FakeChild extends EventEmitter {
  readonly posted: { type: string; samples?: Float32Array }[] = []
  constructor(readonly cpuOnly: boolean) {
    super()
  }
  postMessage(message: { type: string; samples?: Float32Array }): void {
    this.posted.push(message)
  }
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
  attachAudioPort(): boolean {
    return true
  }
}

function setup(): {
  worker: ReturnType<typeof spawnSttWorkerWithCpuFallback>
  children: FakeChild[]
  events: unknown[]
  marks: () => number
} {
  const children: FakeChild[] = []
  let marks = 0
  const worker = spawnSttWorkerWithCpuFallback(
    ({ cpuOnly }) => {
      const child = new FakeChild(cpuOnly)
      children.push(child)
      return child
    },
    { allowGpu: () => true, markGpuFailed: () => void (marks += 1) }
  )
  const events: unknown[] = []
  worker.on('message', (event: unknown) => events.push(event))
  worker.postMessage({
    type: 'init',
    speechModulesDir: '/app/node_modules',
    modelDir: '/models/parakeet',
    sampleRate: 16000,
    files: ['model-Q8_0.gguf']
  })
  return { worker, children, events, marks: () => marks }
}

const feed = (
  n: number
): { type: 'feed'; streamId: string; samples: Float32Array; sampleRate: number } => ({
  type: 'feed',
  streamId: '1',
  samples: new Float32Array(n),
  sampleRate: 16000
})

describe('GPU speech process falling back to the CPU', () => {
  it('replays only the audio the GPU had not decoded when it crashes mid-stop', () => {
    const { worker, children, events, marks } = setup()
    const [gpu] = children
    gpu.emit('message', { type: 'ready' })
    worker.postMessage(feed(300))
    worker.postMessage(feed(300))
    gpu.emit('message', { type: 'chunk', streamId: '1', text: 'first', samples: 400 })
    worker.postMessage(feed(300))
    worker.postMessage({ type: 'stop', streamId: '1' })
    gpu.emit('exit', 1)
    // The dead process's late messages must not settle the stop or duplicate text.
    gpu.emit('message', { type: 'chunk', streamId: '1', text: 'late', samples: 900 })
    gpu.emit('message', { type: 'stopped', streamId: '1' })

    const cpu = children[1]
    expect(cpu.cpuOnly).toBe(true)
    expect(cpu.posted.map((m) => [m.type, m.samples?.length])).toEqual([
      ['init', undefined],
      ['feed', 200],
      ['feed', 300],
      ['stop', undefined]
    ])
    expect(marks()).toBe(0)
    cpu.emit('message', { type: 'ready' })
    expect(marks()).toBe(1)
    cpu.emit('message', { type: 'chunk', streamId: '1', text: 'second', samples: 500 })
    cpu.emit('message', { type: 'stopped', streamId: '1' })
    expect(events).toEqual([
      { type: 'ready' },
      { type: 'final', streamId: '1', text: 'first' },
      { type: 'final', streamId: '1', text: 'second' },
      { type: 'stopped', streamId: '1' }
    ])
  })

  it('does not replay a canceled dictation', () => {
    const { worker, children } = setup()
    const [gpu] = children
    gpu.emit('message', { type: 'ready' })
    worker.postMessage(feed(100))
    worker.postMessage({ type: 'discard', streamId: '1' })
    gpu.emit('exit', 1)
    expect(children[1].posted.map((m) => m.type)).toEqual(['init', 'discard'])
  })

  it('reports an idle GPU process killed between dictations instead of moving it to the CPU', () => {
    const { worker, children, marks } = setup()
    const [gpu] = children
    const exits: number[] = []
    worker.on('exit', (code: number) => exits.push(code))
    gpu.emit('message', { type: 'ready' })
    worker.postMessage({ type: 'stop', streamId: '1' })
    gpu.emit('message', { type: 'stopped', streamId: '1' })
    gpu.emit('exit', 137)
    expect(children).toHaveLength(1)
    expect(exits).toEqual([137])
    expect(marks()).toBe(0)
  })

  it('keeps a slow GPU load that still finishes its steps, and moves a silent one to the CPU', () => {
    vi.useFakeTimers()
    try {
      const { children, events } = setup()
      const [gpu] = children
      vi.advanceTimersByTime(20_000)
      gpu.emit('message', { type: 'loading' })
      vi.advanceTimersByTime(20_000)
      gpu.emit('message', { type: 'loading' })
      vi.advanceTimersByTime(20_000)
      gpu.emit('message', { type: 'ready' })
      expect(children).toHaveLength(1)
      expect(events).toEqual([{ type: 'ready' }])

      const silent = setup()
      vi.advanceTimersByTime(20_000)
      silent.children[0].emit('message', { type: 'loading' })
      vi.advanceTimersByTime(25_000)
      expect(silent.children).toHaveLength(2)
      expect(silent.children[1].cpuOnly).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails the worker when the CPU replacement cannot load the model mid-dictation', () => {
    const { worker, children } = setup()
    const exits: number[] = []
    worker.on('exit', (code: number) => exits.push(code))
    children[0].emit('message', { type: 'ready' })
    worker.postMessage(feed(100))
    children[0].emit('exit', 1)
    children[1].emit('message', { type: 'error', error: 'model load failed' })
    expect(exits).toEqual([1])
  })
})
