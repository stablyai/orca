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

export function galleryBenchmarkSnapshot(
  count: number,
  giant: boolean,
  image: boolean
): NativeChatGallerySnapshot {
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
    allowFileUriLinks: false,
    slots,
    waitingSlots: [],
    stoppedLabel: 'Stopped before starting',
    visuals: true
  }
}
