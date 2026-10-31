import { z } from 'zod'
import { PiRpcDialogCallbacks } from '../pi/rpc-dialog-callbacks'
import { piRpcDialogPresentation, type PiRpcDialogPresentation } from '../pi/rpc-extension-dialogs'
import type { JsonlRpcTimelineLane } from '../jsonl-rpc/timeline-lane'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import { ompRpcNoticeTone } from './rpc-notifications'
import { OmpRpcAskGroups } from './rpc-ask-groups'

const askSchema = z.object({
  id: z.string(),
  method: z.literal('ask'),
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        question: z.string(),
        header: z.string().optional(),
        options: z
          .array(
            z.object({
              label: z.string(),
              description: z.string().optional(),
              preview: z.string().optional()
            })
          )
          .max(64),
        multi: z.boolean().optional(),
        recommended: z.number().optional()
      })
    )
    .min(1)
    .max(64)
})

export function ompRpcDialogPresentation(value: unknown): PiRpcDialogPresentation | null {
  if (z.object({ secret: z.literal(true) }).safeParse(value).success) {
    return null
  }
  if (z.object({ method: z.literal('ask'), timeout: z.number() }).safeParse(value).success) {
    return null
  }
  const ask = askSchema.safeParse(value)
  if (!ask.success) {
    return piRpcDialogPresentation(value)
  }
  const { id, questions } = ask.data
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    return null
  }
  return {
    id,
    body: {
      kind: 'question',
      question: questions[0]!.question,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null },
      questions: questions.map((question) => ({
        id: question.id,
        question: question.question,
        ...(question.header ? { header: question.header } : {}),
        multiSelect: question.multi === true,
        freeTextQuestionId: question.id,
        options: question.options.map((option, index) => ({
          id: `option-${index}`,
          label: option.label,
          ...(option.description ? { description: option.description } : {})
        }))
      }))
    },
    reply: (response) => {
      if (response === null) {
        return { cancelled: true }
      }
      if (response.kind !== 'answers' || response.answers.length !== questions.length) {
        throw new Error('OMP Ask requires an answer to every question')
      }
      const answers = questions.map((question) => {
        const matching = response.answers.filter((answer) => answer.questionId === question.id)
        if (matching.length !== 1) {
          throw new Error('OMP Ask answer has an invalid question identity')
        }
        const answer = matching[0]!
        if (
          (!question.multi &&
            (answer.optionIds.length > 1 ||
              (answer.optionIds.length > 0 && answer.other?.trim()))) ||
          new Set(answer.optionIds).size !== answer.optionIds.length
        ) {
          throw new Error('OMP Ask answer has invalid selections')
        }
        const selectedOptions = answer.optionIds.map((optionId) => {
          const index = question.options.findIndex((_, index) => optionId === `option-${index}`)
          if (index === -1) {
            throw new Error('OMP Ask answer selected an unavailable option')
          }
          return question.options[index]!.label
        })
        if (!question.multi && selectedOptions.length === 0 && !answer.other?.trim()) {
          throw new Error('OMP Ask requires a selection or text')
        }
        return {
          id: question.id,
          selectedOptions,
          ...(answer.other !== undefined ? { customInput: answer.other } : {})
        }
      })
      return { answers }
    }
  }
}

export function createOmpRpcDialogs(
  lane: JsonlRpcTimelineLane,
  send: (frame: JsonlRpcRecord) => Promise<void>,
  fail: (error: Error) => void
): Pick<PiRpcDialogCallbacks, 'receive' | 'respond' | 'cancelAll'> {
  let notice = 0
  const groups = new OmpRpcAskGroups(ompRpcDialogPresentation, send)
  const callbacks = new PiRpcDialogCallbacks(lane, groups.reply, fail, {
    present: ompRpcDialogPresentation,
    receive: (frame, callbacks) => {
      if (frame.method === 'cancel' && typeof frame.targetId === 'string') {
        groups.withdraw(frame.targetId, callbacks)
        return true
      }
      if (groups.receive(frame, callbacks)) {
        return true
      }
      const decoration = [
        'notify',
        'setStatus',
        'setWidget',
        'setTitle',
        'set_editor_text',
        'open_url'
      ].includes(String(frame.method))
      if (decoration) {
        const text =
          typeof frame.message === 'string'
            ? frame.message
            : typeof frame.statusText === 'string'
              ? frame.statusText
              : typeof frame.url === 'string'
                ? [frame.instructions, frame.launchUrl ?? frame.url]
                    .filter((part) => typeof part === 'string')
                    .join('\n')
                : Array.isArray(frame.widgetLines)
                  ? frame.widgetLines
                      .filter((line): line is string => typeof line === 'string')
                      .join('\n')
                  : typeof frame.text === 'string'
                    ? `OMP editor suggestion:\n${frame.text}`
                    : typeof frame.title === 'string'
                      ? frame.title
                      : undefined
        if (text) {
          lane.apply([
            {
              type: 'item.close',
              item: `omp-notice:${++notice}`,
              body: {
                kind: 'status',
                text,
                tone: ompRpcNoticeTone(frame.notifyType)
              }
            }
          ])
        }
        return true
      }
      if (!ompRpcDialogPresentation(frame)) {
        lane.apply([
          {
            type: 'item.close',
            item: `omp-notice:${++notice}`,
            body: {
              kind: 'status',
              text:
                frame.method === 'ask' && typeof frame.timeout === 'number'
                  ? 'OMP timed Ask was cancelled: its native deadline may select recommended answers before the host can respond. Use an untimed Ask.'
                  : `OMP interaction cannot be displayed: ${String(frame.method)}. The request was cancelled.`,
              tone: 'error'
            }
          }
        ])
      }
      return false
    }
  })
  return {
    receive: (frame) => callbacks.receive(frame),
    respond: async (...args) => {
      await callbacks.respond(...args)
      if (args[3] === false) {
        groups.forgetRow(args[0], (item, id) => lane.isRequestRow(item, id))
      }
      try {
        groups.advance(callbacks)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    },
    cancelAll: () => {
      callbacks.cancelAll()
      groups.clear()
    }
  }
}
