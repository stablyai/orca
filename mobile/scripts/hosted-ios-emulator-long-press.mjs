import {
  runHostedIosEmulatorCommand,
  waitForHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlByLabelPrefix
} from './hosted-ios-emulator-accessibility.mjs'

// Why: a single `gesture` command delivers its whole point list as one batch, so
// begin/hold-frames/end lands as a tap however many hold frames it carries. The
// touch only stays down across separate commands, so the press is split in two.
const LONG_PRESS_HOLD_MS = 900
const LONG_PRESS_SETTLE_TIMEOUT_MS = 8_000

export async function longPressHostedIosAccessibilityControlByLabelPrefix(
  args,
  labelPrefix,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand,
  settledLabel = null
) {
  const deadline = Date.now() + timeoutMs
  const point = await waitForHostedIosAccessibilityControlByLabelPrefix(
    args,
    labelPrefix,
    timeoutMs,
    runCommand
  )
  await longPressHostedIosPoint(args, point, runCommand, { deadline, settledLabel })
  return point
}

export async function longPressHostedIosPoint(
  args,
  point,
  runCommand = runHostedIosEmulatorCommand,
  { deadline = Date.now() + LONG_PRESS_SETTLE_TIMEOUT_MS, settledLabel = null } = {}
) {
  const sendGesture = (points) => runCommand(args, ['gesture', JSON.stringify(points)])
  // The move frame flushes the touch down; a lone begin never reaches the app.
  await sendGesture([
    { type: 'begin', ...point },
    { type: 'move', ...point }
  ])
  try {
    await delay(LONG_PRESS_HOLD_MS)
    if (settledLabel) {
      await waitForHostedIosAccessibilityControl(
        args,
        settledLabel,
        Math.min(LONG_PRESS_SETTLE_TIMEOUT_MS, Math.max(1_000, deadline - Date.now())),
        runCommand
      )
    }
  } finally {
    // Always lift: a stuck touch poisons every later step on the device.
    await sendGesture([
      { type: 'move', ...point },
      { type: 'end', ...point }
    ])
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
