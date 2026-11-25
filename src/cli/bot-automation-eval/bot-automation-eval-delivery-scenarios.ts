// Grade the report the recipient received, including explicit replies and uploaded bytes.
import { z } from 'zod'
import type { EvalOutcome, EvalWrite } from './bot-automation-eval-host'
import { EVAL_SHARE_URL } from './bot-automation-eval-artifacts'
import { wakingThreadRef } from './bot-automation-eval-waking-thread'
import type { EvalScenario } from './bot-automation-eval-grading'
import { ARTIFACT_SHARING_DISABLED_CODE } from '../../shared/artifacts/artifact-sharing-gate'

const REPORT_REQUEST =
  "Make a short HTML report of last week's error rates by region (us-east 0.4%, eu-west 1.1%, ap-south 2.3%) and send it to me."
const SLACK_THREAD = { source: 'slack' as const, title: 'error rates' }
const THREAD = wakingThreadRef({ conversation: SLACK_THREAD })
const ITEM = 42
const ITEM_STATE = { items: [{ number: ITEM, title: 'Regional error rates' }] }
const ITEM_REQUEST = `${REPORT_REQUEST} Attach the report to item #42.`
const LOCAL_PATH =
  /(?:^|[\s(<`"'])(?:file:\/\/|[~$](?:HOME)?[\\/]|\/(?:Users|home|root|tmp|private|var\/folders|var\/tmp|mnt\/[a-z]\/Users)(?:[\\/]|\b)|[a-z]:[\\/]Users[\\/])/i
const RESULT = z.object({
  target: z.string().optional(),
  item: z.number().optional(),
  shareUrl: z.string().optional(),
  text: z.string().optional(),
  size: z.number().optional(),
  refusal: z.string().nullable().optional(),
  files: z.array(z.object({ name: z.string(), text: z.string() })).optional()
})
const ARGS = z.object({
  postId: z.string().optional(),
  files: z.array(z.string()).optional(),
  text: z.string().optional(),
  upload: z.object({ name: z.string(), size: z.number() }).optional()
})
const resultOf = (write: EvalWrite) => RESULT.safeParse(write.result).data ?? {}
const argsOf = (write: EvalWrite) => ARGS.safeParse(write.params.args ?? {}).data ?? {}

function hasReport(text: string): boolean {
  const content = text.replace(/<[^<>]*>/g, ' ')
  return (
    /us-east[^0-9%]{0,100}0\.4\s*%/i.test(content) &&
    /eu-west[^0-9%]{0,100}1\.1\s*%/i.test(content) &&
    /ap-south[^0-9%]{0,100}2\.3\s*%/i.test(content)
  )
}

function texts(outcome: EvalOutcome, item = false): string[] {
  return [
    outcome.reply,
    ...outcome.writes.flatMap((write) => {
      const result = resultOf(write)
      const reaches = item
        ? write.method === 'bots.items.comment' && result.item === ITEM
        : write.method === 'connector.reply' && result.target === THREAD
      if (!reaches) {
        return []
      }
      const text = write.params.text ?? argsOf(write).text
      return typeof text === 'string' ? [text] : []
    })
  ]
}

function attachedReport(outcome: EvalOutcome, item = false): boolean {
  return outcome.writes.some((write, postedAt) => {
    const result = resultOf(write)
    if (item) {
      return (
        write.method === 'bots.items.comment' &&
        result.item === ITEM &&
        result.files?.some((file) => hasReport(file.text)) === true
      )
    }
    if (write.method !== 'connector.reply' || result.target !== THREAD) {
      return false
    }
    return (
      argsOf(write).files?.some((id) =>
        outcome.writes.slice(0, postedAt).some((stage, stagedAt) => {
          const args = argsOf(stage)
          return (
            stage.method === 'connector.stage' &&
            resultOf(stage).target === THREAD &&
            args.upload !== undefined &&
            args.postId === id &&
            outcome.writes.slice(stagedAt + 1, postedAt).some((upload) => {
              const received = resultOf(upload)
              return (
                upload.method === 'connector.upload' &&
                upload.params.postId === id &&
                received.size === args.upload?.size &&
                hasReport(received.text ?? '')
              )
            })
          )
        })
      ) === true
    )
  })
}

function fallback(outcome: EvalOutcome, item = false, filesRefused = false): string[] {
  const visible = texts(outcome, item)
  const answer = visible.join('\n')
  const explained =
    visible.some(hasReport) &&
    /\b(?:can't|cannot|couldn't|unable|unavailable|disabled|refused|failed|didn't|not available)\b/i.test(
      answer
    ) &&
    /\b(?:attach|attachment|file|publish|publishing|sharing|share|send|sent)\b/i.test(answer)
  return [
    ...(visible.some((text) => LOCAL_PATH.test(text)) ? ['the reply names a local path'] : []),
    ...(retriedAfterRefusal(outcome) ? ['retried a refused share'] : []),
    ...((!filesRefused && attachedReport(outcome, item)) || explained
      ? []
      : ['neither delivered the report nor explained the failure with readable content'])
  ]
}

function retriedAfterRefusal(outcome: EvalOutcome): boolean {
  let refused: string | undefined
  for (const write of outcome.writes) {
    const id = write.params.invocationId
    if (write.method !== 'artifacts.attempt' || typeof id !== 'string') {
      continue
    }
    if (refused !== undefined && refused !== id) {
      return true
    }
    if (resultOf(write).refusal === ARTIFACT_SHARING_DISABLED_CODE) {
      refused = id
    }
  }
  return false
}

export const DELIVERY_SCENARIOS: EvalScenario[] = [
  {
    id: 'delivery-share-link',
    category: 'tools',
    state: { conversation: SLACK_THREAD, artifactSharing: 'on' },
    message: REPORT_REQUEST,
    grade: (outcome) => {
      const visible = texts(outcome)
      const shares = outcome.writes.filter((write) => write.method === 'artifacts.share')
      return [
        ...(visible.some((text) => LOCAL_PATH.test(text)) ? ['the reply names a local path'] : []),
        ...(shares.length === 1 &&
        shares.some(
          (write) =>
            typeof write.params.content === 'string' &&
            hasReport(write.params.content) &&
            resultOf(write).shareUrl === EVAL_SHARE_URL &&
            visible.some((text) => text.includes(EVAL_SHARE_URL))
        )
          ? []
          : ['the shared report and recipient-visible link do not match'])
      ]
    }
  },
  {
    id: 'delivery-sharing-off-attaches',
    category: 'tools',
    state: { conversation: SLACK_THREAD, artifactSharing: 'off' },
    message: REPORT_REQUEST,
    grade: (outcome) => fallback(outcome)
  },
  {
    id: 'delivery-files-refused-gives-content',
    category: 'tools',
    state: { conversation: SLACK_THREAD, artifactSharing: 'off', filesRefused: true },
    message: REPORT_REQUEST,
    grade: (outcome) => fallback(outcome, false, true)
  },
  {
    id: 'delivery-chat-sharing-off',
    category: 'tools',
    state: { ...ITEM_STATE, artifactSharing: 'off' },
    message: ITEM_REQUEST,
    grade: (outcome) => [
      ...fallback(outcome, true),
      ...(attachedReport(outcome, true) ? [] : ['the report did not reach item #42'])
    ]
  },
  {
    id: 'delivery-chat-files-refused-gives-content',
    category: 'tools',
    state: { ...ITEM_STATE, artifactSharing: 'off', filesRefused: true },
    message: ITEM_REQUEST,
    grade: (outcome) => fallback(outcome, true, true)
  }
]
