import { NativeChatGalleryProjectionLimitError } from '../../../src/renderer/src/components/native-chat/media/gallery/native-chat-gallery-projection-budget'
import { galleryBenchmarkSnapshot } from './gallery-index-benchmark-transcript'
import { NativeChatGalleryClient } from '../../../src/renderer/src/components/native-chat/media/gallery/native-chat-gallery-client'

type WireSamples = { count: number; bytes: number; maxBytes: number; oversized: number }
let wire: { sent: WireSamples; received: WireSamples } | null = null
const emptyWire = (): WireSamples => ({ count: 0, bytes: 0, maxBytes: 0, oversized: 0 })
function recordWire(direction: 'sent' | 'received', value: unknown): void {
  const sample = wire?.[direction]
  if (!sample) {
    return
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  sample.count++
  sample.bytes += bytes
  sample.maxBytes = Math.max(sample.maxBytes, bytes)
  sample.oversized += bytes > 65536 ? 1 : 0
}
class MeteredWorker extends Worker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options)
    this.addEventListener('message', (event) => recordWire('received', event.data))
  }
  override postMessage(
    value: unknown,
    options?: Transferable[] | StructuredSerializeOptions
  ): void {
    recordWire('sent', value)
    if (Array.isArray(options)) {
      super.postMessage(value, options)
    } else {
      super.postMessage(value, options)
    }
  }
}
Object.assign(window, { Worker: MeteredWorker })

type GalleryBenchmarkOptions = {
  count: number
  giant?: boolean
  image?: boolean
  warm?: boolean
  cancel?: boolean
  stream?: boolean
  repeat?: number
  largeFields?: boolean
  manyImages?: boolean
  largeTool?: boolean
  update?: boolean
  serializedTool?: boolean
  longRun?: boolean
  largeSource?: boolean
  hugeDocument?: boolean
}
async function runGalleryBenchmark(options: GalleryBenchmarkOptions): Promise<unknown> {
  const data = galleryBenchmarkSnapshot(
    options.count,
    options.giant ?? false,
    options.image ?? true
  )
  const first = data.slots[0]
  if (first?.kind === 'message' && options.largeFields) {
    first.message.blocks = [
      { type: 'image-ref', path: '/fixture/large.png', alt: '😀'.repeat(500_000) }
    ]
  }
  if (first?.kind === 'message' && options.manyImages) {
    first.message.blocks = [
      {
        type: 'text',
        text: Array.from(
          { length: 4000 },
          (_, index) => `![${index}](/fixture/many-${index}.png)`
        ).join('\n\n')
      }
    ]
  }
  if (first?.kind === 'message' && options.largeTool) {
    first.message.blocks = [
      {
        type: 'tool-call',
        name: 'Read',
        state: 'completed',
        input: { file_path: '/fixture/read.png', unrelated: 'seed '.repeat(400_000) }
      },
      { type: 'tool-result', output: 'bytes '.repeat(400_000) }
    ]
  }
  if (first?.kind === 'message' && options.serializedTool) {
    first.message.blocks = [
      {
        type: 'tool-call',
        name: 'Read',
        state: 'completed',
        input: JSON.stringify({
          file_path: '/fixture/read.png',
          unrelated: 'seed '.repeat(400_000)
        })
      }
    ]
  }
  if (first?.kind === 'message' && options.longRun) {
    first.workRun = Array.from({ length: 513 }, (_, index) => ({
      ...first.message,
      id: `member-${index}`
    }))
  }
  if (first?.kind === 'message' && options.largeSource) {
    first.message.blocks = [
      { type: 'image-ref', url: `data:image/png;base64,${'a'.repeat(2_000_000)}` }
    ]
  }
  if (first?.kind === 'message' && options.hugeDocument) {
    first.message.blocks = [
      { type: 'text', text: `${'a'.repeat(2_000_000)}\n\n![large](/fixture/large-document.png)` }
    ]
  }
  const longTasks: { start: number; duration: number }[] = []
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTasks.push({ start: entry.startTime, duration: entry.duration })
    }
  })
  observer.observe({ type: 'longtask', buffered: false })
  const client = new NativeChatGalleryClient()
  const samples: unknown[] = []
  const escapeEvents: number[] = []
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      escapeEvents.push(performance.now())
      performance.mark('native-chat-gallery:benchmark-escape')
    }
  }
  window.addEventListener('keydown', onKey)
  try {
    for (let run = 0; run < (options.repeat ?? (options.warm ? 2 : 1)); run++) {
      const sampleWire = { sent: emptyWire(), received: emptyWire() }
      wire = sampleWire
      const started = performance.now()
      let inputDelay = 0
      const scheduled = performance.now() + 25
      const input = new Promise<void>((resolve) => {
        setTimeout(() => {
          inputDelay = performance.now() - scheduled
          resolve()
        }, 25)
      })
      const frontier = data.slots.at(-1)
      const revisionData =
        options.update && run > 0 && frontier?.kind === 'message'
          ? {
              ...data,
              slots: [
                ...data.slots.slice(0, -1),
                {
                  ...frontier,
                  message: {
                    ...frontier.message,
                    blocks: [{ type: 'text' as const, text: '![appended](/fixture/appended.png)' }]
                  }
                }
              ]
            }
          : data
      let pending = client.index(revisionData)
      const superseded = [pending]
      if (options.stream) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
        const frontier = data.slots.at(-1)
        if (frontier?.kind !== 'message') {
          throw new Error('Missing seeded frontier')
        }
        for (let update = 0; update < 10; update++) {
          const next = {
            ...frontier,
            activeTurnIsWorking: true,
            trailingRun: true,
            message: {
              ...frontier.message,
              blocks: [
                {
                  type: 'text' as const,
                  text: `Streaming image ![latest](/fixture/stream-${update}.png)`
                }
              ]
            }
          }
          pending = client.index({ ...data, slots: [...data.slots.slice(0, -1), next] })
          superseded.push(pending)
          await new Promise<void>((resolve) => setTimeout(resolve, 1))
        }
      }
      if (options.cancel) {
        setTimeout(() => client.close(), 10)
      }
      let rejectedProjection = false
      const result = await pending.catch((error: unknown) => {
        if (
          (options.serializedTool || options.longRun) &&
          error instanceof NativeChatGalleryProjectionLimitError
        ) {
          rejectedProjection = true
          return null
        }
        throw error
      })
      const revisions = await Promise.allSettled(superseded)
      const totalMs = performance.now() - started
      await input
      samples.push({
        run,
        totalMs,
        wire: sampleWire,
        inputTaskDelayMs: inputDelay,
        imageCount: result?.entries.length ?? null,
        rejectedProjection,
        latestImage: options.stream ? (result?.entries.at(-1)?.source ?? null) : undefined,
        supersededRevisions: options.stream
          ? revisions.filter(
              (revision) => revision.status === 'fulfilled' && revision.value === null
            ).length
          : undefined,
        metrics: result?.metrics ?? null
      })
      if (options.repeat) {
        client.close()
      }
    }
    return {
      samples,
      longTasks,
      escapeEvents,
      platform: navigator.userAgent
    }
  } finally {
    window.removeEventListener('keydown', onKey)
    observer.disconnect()
    client.close()
    wire = null
  }
}

Object.assign(window, { runGalleryBenchmark })
