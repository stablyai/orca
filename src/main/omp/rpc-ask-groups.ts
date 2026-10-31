import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { PiRpcDialogCallbacks } from '../pi/rpc-dialog-callbacks'
import type { PiRpcDialogPresentation } from '../pi/rpc-extension-dialogs'
import { MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'

const answersSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      selectedOptions: z.array(z.string()),
      customInput: z.string().optional()
    })
  )
})

type AskGroup = {
  id: string
  pages: JsonlRpcRecord[]
  index: number
  answers: z.infer<typeof answersSchema>['answers']
  next?: JsonlRpcRecord
}

/** Keep host-sized cards local; OMP receives one complete reply to its original request. */
export class OmpRpcAskGroups {
  private readonly groups = new Map<string, AskGroup>()
  private readonly pages = new Map<string, AskGroup>()

  constructor(
    private readonly present: (frame: unknown) => PiRpcDialogPresentation | null,
    private readonly send: (frame: JsonlRpcRecord) => Promise<void>
  ) {}

  receive(frame: JsonlRpcRecord, callbacks: PiRpcDialogCallbacks): boolean {
    if (
      frame.method !== 'ask' ||
      typeof frame.id !== 'string' ||
      !Array.isArray(frame.questions) ||
      frame.questions.length <= MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS ||
      !this.present(frame)
    ) {
      return false
    }
    if (this.groups.has(frame.id)) {
      throw new Error('OMP Ask identity violation')
    }
    const pages: JsonlRpcRecord[] = []
    for (
      let start = 0;
      start < frame.questions.length;
      start += MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS
    ) {
      pages.push({
        ...frame,
        id: `orca-omp-ask:${randomUUID()}`,
        questions: frame.questions.slice(start, start + MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS)
      })
    }
    const group: AskGroup = { id: frame.id, pages, index: 0, answers: [] }
    this.groups.set(group.id, group)
    this.pages.set(String(pages[0]!.id), group)
    try {
      callbacks.receive(pages[0]!)
    } catch (error) {
      this.forget(group)
      throw error
    }
    return true
  }

  reply = async (frame: JsonlRpcRecord): Promise<void> => {
    const group = this.pages.get(String(frame.id))
    if (!group) {
      return this.send(frame)
    }
    if (frame.cancelled === true) {
      await this.send({ ...frame, id: group.id })
      this.forget(group)
      return
    }
    const { answers } = answersSchema.parse(frame)
    const next = group.pages[group.index + 1]
    if (next) {
      group.answers.push(...answers)
      group.next = next
      return
    }
    await this.send({ ...frame, id: group.id, answers: [...group.answers, ...answers] })
    this.forget(group)
  }

  advance(callbacks: PiRpcDialogCallbacks): void {
    for (const group of this.groups.values()) {
      const next = group.next
      if (!next) {
        continue
      }
      this.pages.delete(String(group.pages[group.index]!.id))
      group.next = undefined
      group.index++
      this.pages.set(String(next.id), group)
      callbacks.receive(next)
    }
  }

  withdraw(id: string, callbacks: PiRpcDialogCallbacks): void {
    const group = this.groups.get(id)
    callbacks.withdraw(group ? String(group.pages[group.index]!.id) : id)
    if (group) {
      this.forget(group)
    }
  }

  clear(): void {
    this.groups.clear()
    this.pages.clear()
  }

  forgetRow(itemId: string, matches: (itemId: string, requestId: string) => boolean): void {
    for (const [id, group] of this.pages) {
      if (matches(itemId, id)) {
        this.forget(group)
        return
      }
    }
  }

  private forget(group: AskGroup): void {
    this.groups.delete(group.id)
    this.pages.delete(String(group.pages[group.index]!.id))
  }
}
