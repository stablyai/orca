// A running turn as an IM message shows it: the newest thought's tail, the newest steps, then the
// answer so far. Structured for a card that lays the parts out itself, or rendered as plain text.
import type { ImStep, ImStepState } from './im-stream-step'
import type { ImTurnView } from './im-stream-turn-view'

export const IM_THINKING_CHARS = 280
export const IM_SHOWN_STEPS = 6

export const IM_STEP_MARK: Record<ImStepState, string> = {
  running: '⏳',
  completed: '✅',
  failed: '❌'
}

export type ImProgressOptions = {
  /** Thinking characters shown, newest kept. */
  thinkingChars?: number
  /** Thinking shows only until the answer starts. */
  thinkingUntilAnswer?: boolean
  shownSteps?: number
  /** Answer characters shown, newest kept; the whole answer when absent. */
  answerChars?: number
}

export type ImProgress = {
  /** The thought's tail on one line; empty when there is none to show. */
  thinking: string
  /** The newest steps, oldest first. */
  steps: ImStep[]
  /** How many earlier steps are left out. */
  earlierSteps: number
  answer: string
  /** Nothing to show yet, or a step still runs with no answer: the message says it is working. */
  working: boolean
}

/** The text's newest `max` characters on one line, `…` marking a cut. */
export function imTail(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `…${line.slice(line.length - max + 1).trimStart()}`
}

export function imProgress(view: ImTurnView, options: ImProgressOptions = {}): ImProgress {
  const answer = view.answer.trim()
  const thinking =
    options.thinkingUntilAnswer && answer
      ? ''
      : imTail(view.thinking, options.thinkingChars ?? IM_THINKING_CHARS)
  const shownSteps = options.shownSteps ?? IM_SHOWN_STEPS
  const steps = view.steps.slice(-shownSteps)
  const max = options.answerChars
  return {
    thinking,
    steps,
    earlierSteps: view.steps.length - steps.length,
    answer:
      max === undefined || answer.length <= max ? answer : `…${answer.slice(answer.length - max)}`,
    working: !answer && (view.steps.at(-1)?.state === 'running' || (!thinking && !steps.length))
  }
}

export type ImProgressFormat = ImProgressOptions & {
  /** Shown before any thinking, step or answer arrives. */
  waiting: string
  /** How the platform shows thinking; one without a thinking block gets a quote or a mark. */
  thinking: (text: string) => string
  /** Shown above the steps when earlier ones were left out. */
  earlierSteps: (count: number) => string
  /** One step's line; its mark and summary when absent. */
  step?: (step: ImStep) => string
  /** Shown under a step still running while no answer has come. */
  working?: string
}

const stepLine = (step: ImStep): string => `${IM_STEP_MARK[step.state]} ${step.summary}`

/** The in-progress message as plain text, sections a blank line apart. */
export function renderImProgress(view: ImTurnView, format: ImProgressFormat): string {
  const progress = imProgress(view, format)
  const sections: string[] = []
  if (progress.thinking) {
    sections.push(format.thinking(progress.thinking))
  }
  if (progress.steps.length > 0) {
    const lines = progress.steps.map(format.step ?? stepLine)
    if (progress.earlierSteps > 0) {
      lines.unshift(format.earlierSteps(progress.earlierSteps))
    }
    if (progress.working && format.working) {
      lines.push(format.working)
    }
    sections.push(lines.join('\n'))
  }
  if (progress.answer) {
    sections.push(progress.answer)
  }
  return sections.length > 0 ? sections.join('\n\n') : format.waiting
}
