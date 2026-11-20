import { runProcess } from '@orca/process-host'
import {
  buildServeSimKeyboardFramesForCode,
  buildServeSimKeyboardFramesForText,
  encodeServeSimKeyboardFrame,
  type ServeSimKeyboardFrame
} from '../../shared/emulator/emulator-keyboard-frame'
import { EmulatorError } from './emulator-errors'
import { sendServeSimFrameSequence } from './emulator-gesture-sender'

const PASTEBOARD_TIMEOUT_MS = 15_000
const DEVICECTL_FLAGS = ['--timeout', '10', '--quiet']
const ENTER_USAGE = 40

export type SimulatorTextInputPlan =
  | { kind: 'keys' }
  | { kind: 'paste'; text: string; enterCount: number }

/**
 * US key usages only type what they name on a US hardware layout; any other text goes through the
 * guest pasteboard. Typed trailing newlines stay Enter presses so "text\n" still submits a field;
 * a paste keeps them as text, like any paste.
 */
export function planSimulatorTextInput(
  text: string,
  options: { paste: boolean; usHardwareKeyboard: boolean }
): SimulatorTextInputPlan {
  if (options.paste) {
    return { kind: 'paste', text: text.replaceAll('\r', ''), enterCount: 0 }
  }
  if (options.usHardwareKeyboard && buildServeSimKeyboardFramesForText(text)) {
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
  plan: Extract<SimulatorTextInputPlan, { kind: 'paste' }>,
  pasteKeyCode: string
): Promise<void> {
  const frames: ServeSimKeyboardFrame[] = []
  if (plan.text) {
    await stageSimulatorPasteboard(udid, plan.text)
    frames.push(...(buildServeSimKeyboardFramesForCode(pasteKeyCode, { meta: true }) ?? []))
  }
  for (let index = 0; index < plan.enterCount; index += 1) {
    frames.push({ type: 'down', usage: ENTER_USAGE }, { type: 'up', usage: ENTER_USAGE })
  }
  if (frames.length > 0) {
    await sendServeSimFrameSequence(wsUrl, frames.map(encodeServeSimKeyboardFrame))
  }
}

export type SimulatorTextInput = {
  udid: string
  text: string
  paste: boolean
  wsUrl: string | null
  /** Must resolve false when the layout cannot be read: it could be anything. */
  usHardwareKeyboard: () => Promise<boolean>
  typeKeys: () => Promise<unknown>
  pasteKeyCode: () => Promise<string>
}

// The guest has one pasteboard, so a second paste must not restage it before the first Cmd+V lands.
const pendingInputByDevice = new Map<string, Promise<void>>()

export function typeSimulatorText(input: SimulatorTextInput): Promise<void> {
  const previous = pendingInputByDevice.get(input.udid) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(() => typeSimulatorTextNow(input))
  pendingInputByDevice.set(input.udid, next)
  const clear = (): void => {
    if (pendingInputByDevice.get(input.udid) === next) {
      pendingInputByDevice.delete(input.udid)
    }
  }
  void next.then(clear, clear)
  return next
}

async function typeSimulatorTextNow(input: SimulatorTextInput): Promise<void> {
  const plan = planSimulatorTextInput(input.text, {
    paste: input.paste,
    usHardwareKeyboard: input.paste ? false : await input.usHardwareKeyboard()
  })
  if (plan.kind === 'keys') {
    await input.typeKeys()
    return
  }
  if (!input.wsUrl) {
    throw new EmulatorError('emulator_no_active', 'No active emulator stream for text input')
  }
  await pasteSimulatorText(input.udid, input.wsUrl, plan, await input.pasteKeyCode())
}
