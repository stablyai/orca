import { runProcess } from '@orca/process-host'
import {
  buildServeSimKeyboardFramesForText,
  encodeServeSimKeyboardFrame,
  SERVE_SIM_PASTE_FRAMES,
  type ServeSimKeyboardFrame
} from '../../shared/emulator/emulator-keyboard-frame'
import { EmulatorError } from './emulator-errors'
import { sendServeSimFrameSequence } from './emulator-gesture-sender'
import { isUSHardwareKeyboard, readSimulatorKeyboards } from './simulator-hardware-keyboard-layout'

const PASTEBOARD_TIMEOUT_MS = 15_000
const DEVICECTL_FLAGS = ['--timeout', '10', '--quiet']
const ENTER_USAGE = 40

export type SimulatorTextInputPlan =
  | { kind: 'keys' }
  | { kind: 'paste'; text: string; enterCount: number }

/**
 * US key usages only type what they name on a US hardware layout; any other text goes through the
 * guest pasteboard. Trailing newlines stay Enter presses so "text\n" still submits a field.
 */
export function planSimulatorTextInput(
  text: string,
  usHardwareKeyboard: boolean
): SimulatorTextInputPlan {
  if (usHardwareKeyboard && buildServeSimKeyboardFramesForText(text)) {
    return { kind: 'keys' }
  }
  const body = text.replace(/[\r\n]+$/, '')
  const enterCount = (text.slice(body.length).match(/\n/g) ?? []).length
  return { kind: 'paste', text: body.replaceAll('\r', ''), enterCount }
}

async function readBack(program: string, args: string[]): Promise<string | null> {
  const result = await runProcess({ program, args, timeoutMs: PASTEBOARD_TIMEOUT_MS })
  return result.code === 0 ? result.stdout : null
}

/** Exit 0 is not proof: simctl pbcopy can leave the guest pasteboard stale, so success needs a matching read-back. */
async function stageSimulatorPasteboard(udid: string, text: string): Promise<void> {
  const routes: { copy: string[]; paste: string[] }[] = [
    {
      copy: ['devicectl', 'device', 'pasteboard', 'copy', '--device', udid, ...DEVICECTL_FLAGS],
      paste: ['devicectl', 'device', 'pasteboard', 'paste', '--device', udid, ...DEVICECTL_FLAGS]
    },
    // Xcode 26 and older have no devicectl pasteboard for simulators.
    { copy: ['simctl', 'pbcopy', udid], paste: ['simctl', 'pbpaste', udid] }
  ]
  for (const route of routes) {
    const copy = await runProcess({
      program: 'xcrun',
      args: route.copy,
      input: text,
      timeoutMs: PASTEBOARD_TIMEOUT_MS
    })
    if (copy.code === 0 && (await readBack('xcrun', route.paste)) === text) {
      return
    }
  }
  throw new EmulatorError(
    'emulator_error',
    'Could not put the text on the simulator pasteboard; neither devicectl nor simctl read it back.'
  )
}

async function pasteSimulatorText(
  udid: string,
  wsUrl: string,
  plan: Extract<SimulatorTextInputPlan, { kind: 'paste' }>
): Promise<void> {
  const frames: ServeSimKeyboardFrame[] = []
  if (plan.text) {
    await stageSimulatorPasteboard(udid, plan.text)
    frames.push(...SERVE_SIM_PASTE_FRAMES)
  }
  for (let index = 0; index < plan.enterCount; index += 1) {
    frames.push({ type: 'down', usage: ENTER_USAGE }, { type: 'up', usage: ENTER_USAGE })
  }
  if (frames.length > 0) {
    await sendServeSimFrameSequence(wsUrl, frames.map(encodeServeSimKeyboardFrame))
  }
}

export async function typeSimulatorText(
  udid: string,
  text: string,
  wsUrl: string | null,
  typeKeys: () => Promise<unknown>
): Promise<void> {
  const keyboards = await readSimulatorKeyboards(udid).catch(() => null)
  const plan = planSimulatorTextInput(text, isUSHardwareKeyboard(keyboards))
  if (plan.kind === 'keys') {
    await typeKeys()
    return
  }
  if (!wsUrl) {
    throw new EmulatorError('emulator_no_active', 'No active emulator stream for text input')
  }
  await pasteSimulatorText(udid, wsUrl, plan)
}
