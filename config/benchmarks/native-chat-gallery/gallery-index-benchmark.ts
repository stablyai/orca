import { NativeChatGalleryClient } from '../../../src/renderer/src/components/native-chat/media/gallery/native-chat-gallery-client'
import type { NativeChatGallerySnapshot } from '../../../src/renderer/src/components/native-chat/media/gallery/native-chat-gallery-client'
import type { NativeChatMessage } from '../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTranscriptSlot } from '../../../src/renderer/src/components/native-chat/conversation/slots/native-chat-transcript-slots'

function imageMessage(index: number): {
  message: NativeChatMessage
  workRun?: NativeChatMessage[]
} {
  const path = `/fixture/image-${index}.png`
  const message: NativeChatMessage = {
    id: `row-${index}`,
    role: 'assistant',
    timestamp: index,
    source: 'transcript',
    blocks: [
      { type: 'text', text: 'A seeded transcript paragraph with **formatting**. '.repeat(4) }
    ]
  }
  if (index % 20 !== 0) {
    return { message }
  }
  switch ((index / 20) % 10) {
    case 0:
      message.blocks = [{ type: 'image-ref', path }]
      break
    case 1:
      message.blocks = [{ type: 'text', text: `![screenshot](${path})` }]
      break
    case 2:
      message.blocks = [{ type: 'text', text: `[Screenshot](${path})` }]
      break
    case 3:
      message.blocks = [
        { type: 'text', text: `<div><Unknown>seed</Unknown><img src="${path}"></div>` }
      ]
      break
    case 4:
      message.role = 'reasoning'
      message.blocks = [{ type: 'text', text: `![thought](${path})` }]
      break
    case 5:
      message.blocks = [
        { type: 'tool-call', name: 'Read', input: { file_path: path }, state: 'completed' }
      ]
      break
    case 6:
      message.role = 'user'
      message.from = { kind: 'agent', senders: [], orchestration: null }
      message.blocks = [{ type: 'text', text: `![card](${path})` }]
      break
    case 7:
      message.blocks = [{ type: 'text', text: `[Screenshot][screen]\n\n[screen]: ${path}` }]
      break
    case 8: {
      message.blocks = [
        {
          type: 'tool-call',
          name: 'Read',
          input: { file_path: '/fixture/readme.txt' },
          state: 'completed'
        }
      ]
      const thought: NativeChatMessage = {
        id: `thought-${index}`,
        role: 'reasoning',
        source: 'transcript',
        timestamp: index,
        blocks: [{ type: 'text', text: `![grouped thought](${path})` }]
      }
      return { message, workRun: [thought, message] }
    }
    default:
      message.blocks = [
        { type: 'text', text: `[![linked image](${path})](https://example.com/fixture)` }
      ]
  }
  return { message }
}

function snapshot(count: number, giant: boolean, image: boolean): NativeChatGallerySnapshot {
  const slots: NativeChatTranscriptSlot[] = []
  for (let index = 0; index < count; index++) {
    const { message, workRun } = imageMessage(index)
    if (giant) {
      message.blocks = [
        {
          type: 'text',
          text: 'seed '.repeat(20_000) + (image ? '\n\n![giant](/fixture/giant.png)' : '')
        }
      ]
    }
    slots.push({
      kind: 'message',
      message,
      workRun,
      turnKey: undefined,
      receipt: undefined,
      status: undefined,
      folded: false,
      drawsMessage: true,
      turnFolds: false,
      activeTurnIsWorking: false,
      trailingRun: false,
      turnDiff: undefined,
      estimatedHeight: 80
    })
  }
  return {
    scopeKey: 'seeded-gallery',
    slots,
    waitingSlots: [],
    stoppedLabel: 'Stopped before starting',
    visuals: true
  }
}

type GalleryBenchmarkOptions = {
  count: number
  giant?: boolean
  image?: boolean
  warm?: boolean
  cancel?: boolean
  stream?: boolean
  repeat?: number
}
async function runGalleryBenchmark(options: GalleryBenchmarkOptions): Promise<unknown> {
  const data = snapshot(options.count, options.giant ?? false, options.image ?? true)
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
      const started = performance.now()
      let inputDelay = 0
      const scheduled = performance.now() + 25
      const input = new Promise<void>((resolve) => {
        setTimeout(() => {
          inputDelay = performance.now() - scheduled
          resolve()
        }, 25)
      })
      let pending = client.index(data)
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
      const result = await pending
      const revisions = await Promise.all(superseded)
      const totalMs = performance.now() - started
      await input
      samples.push({
        run,
        totalMs,
        inputTaskDelayMs: inputDelay,
        imageCount: result?.entries.length ?? null,
        latestImage: options.stream ? (result?.entries.at(-1)?.source ?? null) : undefined,
        supersededRevisions: options.stream
          ? revisions.filter((revision) => revision === null).length
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
  }
}

Object.assign(window, { runGalleryBenchmark })
