import { writeFileSync, mkdirSync } from 'node:fs'
import { loadavg, cpus } from 'node:os'
import { createIncrementalAssembler, reset, applyAppends } from '@/components/native-chat/session/terminal/assembly/native-chat-incremental-assembler'
import { prepareNativeChatLiveMessages } from '@/components/native-chat/session/terminal/assembly/native-chat-live-message-preparation'
import { nativeChatTurnMembership } from '../shared/native-chat/transcript/turns/native-chat-turn-membership'
import { nativeChatTaskListPredecessors } from '../shared/native-chat/input/task-lists/native-chat-task-list-history'
import { buildNativeChatTranscriptSlots } from '@/components/native-chat/conversation/slots/native-chat-transcript-slots'
import type { NativeChatMessage } from '../shared/native-chat/native-chat-types'

function run() {
  const rows: unknown[] = []
  const measure = (run: () => unknown) => {
    const samples: number[] = []
    for (let repeat = 0; repeat < 24; repeat += 1) {
      const start = performance.now()
      run()
      if (repeat > 3) samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    return { p50: samples[10], p95: samples[19] }
  }
  for (const count of [300, 2000, 8500, 25000, 50000]) {
    const base: NativeChatMessage[] = Array.from({ length: count }, (_, index) => ({
      id: `row-${index}`, role: index % 2 === 0 ? 'user' : 'assistant', timestamp: index,
      source: 'transcript', transcriptOrder: index * 1000,
      blocks: [{ type: 'text', text: `Message ${index}\n\n${'A paragraph of representative chat prose. '.repeat(12)}` }]
    }))
    const assembler = createIncrementalAssembler()
    reset(assembler, base)
    const prepared = prepareNativeChatLiveMessages(assembler.messages, 'claude')
    const membership = nativeChatTurnMembership(prepared)
    const slotsInput = { messages: prepared, ...membership, receipts: new Map(), turnStatuses: { active: null, completedByTurn: {} }, turnDiffs: new Map(), expandedTurnKeys: new Set<string>(), isWorking: false, lifecycleWorking: false }
    const oldSlots = buildNativeChatTranscriptSlots(slotsInput)
    const changed = [...prepared]
    changed[count - 1] = { ...changed[count - 1], blocks: [{ type: 'text', text: 'Updated tail' }] }
    const newSlots = buildNativeChatTranscriptSlots({ ...slotsInput, messages: changed })
    const commonSlots = newSlots.filter((slot, index) => slot === oldSlots[index]).length
    const commonMessages = changed.filter((message, index) => message === prepared[index]).length
    rows.push({ count, retainedSlotObjects: commonSlots, retainedMessageObjects: commonMessages,
      cloneAssemblerMaps: measure(() => ({ byId: new Map(assembler.byId), byTurn: new Map(assembler.byTurn) })),
      reset: measure(() => reset(createIncrementalAssembler(), base)),
      replaceTail: measure(() => {
        const copy = { byId: new Map(assembler.byId), byTurn: new Map(assembler.byTurn), messages: assembler.messages }
        applyAppends(copy, [changed[count - 1]])
      }),
      prepare: measure(() => prepareNativeChatLiveMessages([...base], 'claude')),
      membership: measure(() => nativeChatTurnMembership(prepared)),
      taskLists: measure(() => nativeChatTaskListPredecessors(prepared)),
      slots: measure(() => buildNativeChatTranscriptSlots(slotsInput))
    })
  }
  const output = process.env.AUDIT_OUT ?? '.artifacts/chat-virtualization-audit/data/pipeline'
  mkdirSync(output, { recursive: true })
  writeFileSync(`${output}/pipeline.json`, JSON.stringify({ at: new Date().toISOString(), loadAverage: loadavg(), cpus: cpus().length, rows }, null, 2))
}
run()
