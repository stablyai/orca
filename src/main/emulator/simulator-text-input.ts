import { runProcess } from '@orca/process-host'
import {
  buildServeSimKeyboardFramesForCode,
  encodeServeSimKeyboardFrame,
  type ServeSimKeyboardFrame
} from '../../shared/emulator/emulator-keyboard-frame'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { EmulatorError } from './emulator-errors'
import { sendServeSimFrameSequence } from './emulator-gesture-sender'
import { planEmulatorTextInput, type EmulatorTextInputPlan } from './emulator-text-input-plan'

const PASTEBOARD_TIMEOUT_MS = 15_000
const DEVICECTL_FLAGS = ['--timeout', '10', '--quiet']

type PasteboardRoute = 'devicectl' | 'simctl'

function pasteboardCommand(route: PasteboardRoute, verb: 'copy' | 'paste', udid: string): string[] {
  return route === 'devicectl'
    ? ['devicectl', 'device', 'pasteboard', verb, '--device', udid, ...DEVICECTL_FLAGS]
    : ['simctl', verb === 'copy' ? 'pbcopy' : 'pbpaste', udid]
}

// Xcode 26 and older have no devicectl pasteboard for simulators, so a route that worked goes first.
let pasteboardRoutes: PasteboardRoute[] = ['devicectl', 'simctl']

/** Exit 0 is not proof: simctl pbcopy can leave the guest pasteboard stale, so success needs a matching read-back. */
async function stageSimulatorPasteboard(udid: string, text: string): Promise<void> {
  for (const route of pasteboardRoutes) {
    const run = (verb: 'copy' | 'paste', input?: string) =>
      runProcess({
        program: 'xcrun',
        args: pasteboardCommand(route, verb, udid),
        input,
        timeoutMs: PASTEBOARD_TIMEOUT_MS
      })
    if ((await run('copy', text)).code !== 0) {
      continue
    }
    const readBack = await run('paste')
    if (readBack.code === 0 && readBack.stdout === text) {
      pasteboardRoutes = [route, ...pasteboardRoutes.filter((other) => other !== route)]
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
  plan: Extract<EmulatorTextInputPlan, { kind: 'paste' }>,
  pasteKeyCode: string
): Promise<void> {
  const frames: ServeSimKeyboardFrame[] = []
  if (plan.text) {
    await stageSimulatorPasteboard(udid, plan.text)
    frames.push(...(buildServeSimKeyboardFramesForCode(pasteKeyCode, { meta: true }) ?? []))
  }
  for (let index = 0; index < plan.enterCount; index += 1) {
    frames.push(...(buildServeSimKeyboardFramesForCode('Enter') ?? []))
  }
  if (frames.length > 0) {
    await sendServeSimFrameSequence(wsUrl, frames.map(encodeServeSimKeyboardFrame))
  }
}

type SimulatorTextInput = {
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
  return runKeyedSerializedOperation(pendingInputByDevice, input.udid, () =>
    typeSimulatorTextNow(input)
  )
}

async function typeSimulatorTextNow(input: SimulatorTextInput): Promise<void> {
  const plan = planEmulatorTextInput(input.text, {
    paste: input.paste,
    usKeys: input.paste ? false : await input.usHardwareKeyboard()
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
