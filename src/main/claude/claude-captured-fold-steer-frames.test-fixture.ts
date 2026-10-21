// Claude CLI 2.1.280 stream-json captures of sends made while a turn is running
// (`--replay-user-messages`), cut to the frames and fields the dispatch/turn path
// reads. Ids, paths and prompts are replaced; the frame order and the relative
// clock (`at`, ms after the first send) are the captured ones.
//
// The captured shape under test: a mid-turn send the CLI folds into the running
// turn is replayed as a root user frame (`isReplay: true`, the client uuid) while
// that turn is still open, and the turn's ONE result names every folded send in
// `user_message_uuids`. A send the CLI runs later (miss) is replayed only when its
// own turn starts, after the first result. A cancelled mid-turn send is never
// replayed at all.

import {
  assistant,
  assistantText,
  assistantToolUse,
  initFrame,
  resultFrame,
  sessionIdle,
  taskFrame,
  toolResult,
  userReplay,
  type CapturedFoldFrame,
  type FoldCaptureIds
} from './claude-fold-steer-frame-builders.test-fixture'

export type { CapturedFoldFrame, FoldCaptureIds }

export const FIRST_PROMPT = 'Run the sleep command three times, then reply: FIRST DONE'
export const STEER_PROMPT = 'Also say the word banana at the end of your reply.'
export const SECOND_STEER_PROMPT = 'And also say the word mango at the very end.'

/** p2-fold-fresh: first send at 12, steer at 3878; one result names both sends. */
export const FOLD_FRESH_SEND_AT = { first: 12, steer: 3_878 }
export function foldFreshCapture({ sessionId, first, steer }: FoldCaptureIds): CapturedFoldFrame[] {
  return [
    initFrame(222, sessionId),
    userReplay(2_094, sessionId, first, FIRST_PROMPT),
    assistantToolUse(2_676, sessionId, 'reply-tool-1', 'toolu_sleep_1', [first]),
    toolResult(7_890, sessionId, 'tool-result-1', 'toolu_sleep_1'),
    userReplay(7_892, sessionId, steer, STEER_PROMPT),
    assistantToolUse(9_725, sessionId, 'reply-tool-2', 'toolu_sleep_2'),
    toolResult(14_740, sessionId, 'tool-result-2', 'toolu_sleep_2'),
    assistantText(23_039, sessionId, 'reply-text-1', 'FIRST DONE banana'),
    resultFrame(23_048, sessionId, 'result-1', {
      userMessageUuids: [first, steer],
      durationMs: 22_845,
      numTurns: 4
    }),
    sessionIdle(23_049, sessionId)
  ]
}

/** p2-fold-resumed: the same fold on a `--resume` session; steer at 4458. */
export const FOLD_RESUMED_SEND_AT = { first: 12, steer: 4_458 }
export function foldResumedCapture({
  sessionId,
  first,
  steer
}: FoldCaptureIds): CapturedFoldFrame[] {
  return [
    initFrame(218, sessionId),
    userReplay(2_057, sessionId, first, FIRST_PROMPT),
    assistant(
      3_229,
      sessionId,
      'reply-thinking-1',
      [{ type: 'thinking', thinking: 'plan' }],
      [first]
    ),
    assistantToolUse(3_258, sessionId, 'reply-tool-1', 'toolu_sleep_1'),
    toolResult(8_464, sessionId, 'tool-result-1', 'toolu_sleep_1'),
    userReplay(8_467, sessionId, steer, STEER_PROMPT),
    assistantToolUse(10_318, sessionId, 'reply-tool-2', 'toolu_sleep_2'),
    toolResult(15_373, sessionId, 'tool-result-2', 'toolu_sleep_2'),
    assistantText(23_587, sessionId, 'reply-text-1', 'FIRST DONE banana'),
    resultFrame(23_628, sessionId, 'result-1', {
      userMessageUuids: [first, steer],
      durationMs: 23_367,
      numTurns: 4
    }),
    sessionIdle(23_640, sessionId)
  ]
}

/** p2-two-steers: steers at 3630 and 5031, both replayed back to back mid-turn. */
export const TWO_STEERS_SEND_AT = { first: 31, steer: 3_630, secondSteer: 5_031 }
export function twoSteersCapture({
  sessionId,
  first,
  steer,
  secondSteer
}: Required<FoldCaptureIds>): CapturedFoldFrame[] {
  return [
    initFrame(351, sessionId),
    userReplay(1_169, sessionId, first, FIRST_PROMPT),
    assistantToolUse(2_412, sessionId, 'reply-tool-1', 'toolu_sleep_1', [first]),
    toolResult(7_949, sessionId, 'tool-result-1', 'toolu_sleep_1'),
    userReplay(7_963, sessionId, steer, STEER_PROMPT),
    userReplay(7_967, sessionId, secondSteer, SECOND_STEER_PROMPT),
    assistantToolUse(9_806, sessionId, 'reply-tool-2', 'toolu_sleep_2'),
    toolResult(14_835, sessionId, 'tool-result-2', 'toolu_sleep_2'),
    assistantText(22_210, sessionId, 'reply-text-1', 'FIRST DONE banana mango'),
    resultFrame(22_317, sessionId, 'result-1', {
      userMessageUuids: [first, steer, secondSteer],
      durationMs: 21_859,
      numTurns: 4
    }),
    sessionIdle(22_341, sessionId)
  ]
}

/** p2-miss: the steer lands too late to fold — its replay trails the first
 *  result, and it runs as its own turn with its own result. */
export const MISS_SEND_AT = { first: 30, steer: 23_384 }
export function missCapture({ sessionId, first, steer }: FoldCaptureIds): {
  beforeSteerSend: CapturedFoldFrame[]
  afterSteerSend: CapturedFoldFrame[]
} {
  return {
    beforeSteerSend: [
      initFrame(333, sessionId),
      userReplay(2_118, sessionId, first, FIRST_PROMPT),
      assistantToolUse(2_793, sessionId, 'reply-tool-1', 'toolu_sleep_1', [first]),
      toolResult(8_258, sessionId, 'tool-result-1', 'toolu_sleep_1'),
      assistantToolUse(11_019, sessionId, 'reply-tool-2', 'toolu_sleep_2'),
      toolResult(15_961, sessionId, 'tool-result-2', 'toolu_sleep_2'),
      assistantToolUse(18_362, sessionId, 'reply-tool-3', 'toolu_sleep_3'),
      toolResult(23_375, sessionId, 'tool-result-3', 'toolu_sleep_3')
    ],
    afterSteerSend: [
      assistantText(25_550, sessionId, 'reply-text-1', 'FIRST DONE'),
      resultFrame(25_556, sessionId, 'result-1', {
        userMessageUuids: [first],
        durationMs: 25_241,
        numTurns: 4
      }),
      initFrame(25_584, sessionId),
      userReplay(28_703, sessionId, steer, STEER_PROMPT),
      assistantText(29_239, sessionId, 'reply-text-2', 'banana'),
      resultFrame(29_275, sessionId, 'result-2', {
        userMessageUuids: [steer],
        durationMs: 3_711,
        numTurns: 1
      }),
      sessionIdle(29_306, sessionId)
    ]
  }
}

/** p2-cancel: the steer is cancelled while queued — no replay ever arrives, the
 *  interrupt injects a synthetic user text with NO `isReplay`, and the error
 *  result names only the first send. */
export const CANCEL_SEND_AT = { first: 18, steer: 3_578 }
export function cancelCapture({ sessionId, first, steer: _steer }: FoldCaptureIds): {
  beforeSteerSend: CapturedFoldFrame[]
  afterInterrupt: CapturedFoldFrame[]
} {
  return {
    beforeSteerSend: [
      initFrame(354, sessionId),
      userReplay(1_329, sessionId, first, FIRST_PROMPT),
      assistantToolUse(2_366, sessionId, 'reply-tool-1', 'toolu_sleep_1', [first])
    ],
    afterInterrupt: [
      toolResult(
        3_889,
        sessionId,
        'tool-result-1',
        'toolu_sleep_1',
        "The user doesn't want to proceed with this tool use.",
        true
      ),
      {
        at: 3_900,
        frame: {
          type: 'user',
          session_id: sessionId,
          parent_tool_use_id: null,
          uuid: 'interrupt-notice-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }]
          }
        }
      },
      resultFrame(3_926, sessionId, 'result-1', {
        userMessageUuids: [first],
        durationMs: 3_573,
        numTurns: 3,
        subtype: 'error_during_execution',
        isError: true,
        terminalReason: 'aborted_tools'
      }),
      sessionIdle(3_941, sessionId)
    ]
  }
}

/** p3-early-steer: the steer is written BEFORE the first send's replay arrives
 *  (send at 312, first replay at 1208) and the CLI still folds it — one init,
 *  one turn, one result naming both sends. */
export const EARLY_STEER_SEND_AT = { first: 11, steer: 312 }
export function earlySteerCapture({
  sessionId,
  first,
  steer
}: FoldCaptureIds): CapturedFoldFrame[] {
  return [
    initFrame(205, sessionId),
    userReplay(1_208, sessionId, first, FIRST_PROMPT),
    assistantToolUse(2_190, sessionId, 'reply-tool-1', 'toolu_sleep_1', [first]),
    toolResult(6_316, sessionId, 'tool-result-1', 'toolu_sleep_1'),
    userReplay(6_318, sessionId, steer, STEER_PROMPT),
    assistantText(7_336, sessionId, 'reply-text-1', 'FIRST DONE banana'),
    resultFrame(7_340, sessionId, 'result-1', {
      userMessageUuids: [first, steer],
      durationMs: 7_155,
      numTurns: 2
    }),
    sessionIdle(7_341, sessionId)
  ]
}

/** p3-background-wake: after the turn's result, the finished background task
 *  wakes the CLI — a NEW cycle: its own init, output with no user replay, and a
 *  result that names no send at all (`user_message_uuids` absent). The task's
 *  completion frames arrive BEFORE the wake's init. */
export function backgroundWakeCapture({ sessionId, first }: FoldCaptureIds): {
  firstTurn: CapturedFoldFrame[]
  wake: CapturedFoldFrame[]
} {
  return {
    firstTurn: [
      initFrame(252, sessionId),
      userReplay(1_193, sessionId, first, FIRST_PROMPT),
      assistantToolUse(2_372, sessionId, 'reply-tool-1', 'toolu_bg_1', [first]),
      taskFrame(2_530, sessionId, 'task_started', {
        task_id: 'task_bg_1',
        tool_use_id: 'toolu_bg_1',
        description: 'Sleep then print marker',
        is_backgrounded: true,
        task_type: 'local_bash'
      }),
      toolResult(2_532, sessionId, 'tool-result-1', 'toolu_bg_1'),
      assistantText(3_403, sessionId, 'reply-text-1', 'STARTED'),
      resultFrame(3_406, sessionId, 'result-1', {
        userMessageUuids: [first],
        durationMs: 3_177,
        numTurns: 2
      }),
      sessionIdle(3_407, sessionId)
    ],
    wake: [
      taskFrame(17_547, sessionId, 'task_updated', {
        task_id: 'task_bg_1',
        patch: { status: 'completed' }
      }),
      taskFrame(17_547, sessionId, 'task_notification', {
        task_id: 'task_bg_1',
        tool_use_id: 'toolu_bg_1',
        status: 'completed',
        summary: 'Background command completed (exit code 0)'
      }),
      initFrame(17_626, sessionId),
      assistantText(19_721, sessionId, 'wake-text-1', 'The background command finished.'),
      resultFrame(19_729, sessionId, 'result-2', {
        userMessageUuids: [],
        durationMs: 2_105,
        numTurns: 1
      }),
      sessionIdle(19_730, sessionId)
    ]
  }
}
