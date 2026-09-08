import {
  stageHostedAdversarialTerminalLinksWithInput,
  verifyHostedAdversarialTerminalLinks
} from './hosted-adversarial-terminal-links.mjs'
import {
  tapHostedAndroidAccessibilityControl,
  tapHostedAndroidPoint
} from './hosted-android-emulator-accessibility.mjs'
import { runAndroidAdb } from './hosted-android-mobile-web-cache.mjs'
import { activateHostedWebViewControl } from './hosted-webview-cdp-session.mjs'

const terminalTitle = 'Mobile Emulator'
const terminalInputLabel = 'Show keyboard for live terminal input'
const terminalScriptCommand = 'node ".git/orca-mobile-terminal-links.cjs"'

export function verifyHostedAndroidAdversarialTerminalLinks(args, operations = {}) {
  const verifyLinks = operations.verifyLinks ?? verifyHostedAdversarialTerminalLinks
  return verifyLinks(
    {
      ...args,
      tapPoint: operations.tapPoint ?? tapHostedAndroidPoint
    },
    {
      writeLinks: (linkArgs) =>
        stageHostedAndroidAdversarialTerminalLinks(args, linkArgs, operations)
    }
  )
}

export function hostedAndroidAdversarialTerminalInputText(command) {
  if (command !== terminalScriptCommand) {
    throw new Error('Hosted Android terminal staging command is invalid')
  }
  return 'node%s.git/orca-mobile-terminal-links.cjs'
}

export async function dismissHostedAndroidKeyboardIfShown(adb, runAdb = runAndroidAdb) {
  const state = await runAdb(adb, ['shell', 'dumpsys', 'window'])
  if (!/\bmImeShowing=true\b/u.test(state)) {
    return false
  }
  const navigationBar = [
    ...state.matchAll(
      /InsetsSource id=\S+ type=navigationBars frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\][^\n]*visible=true/gu
    )
  ].at(-1)
  const [left, top, right, bottom] = navigationBar?.slice(1).map(Number) ?? []
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    throw new Error('Hosted Android keyboard navigation bar was unavailable')
  }
  const x = Math.round(left + (right - left) * 0.1)
  const y = Math.round((top + bottom) / 2)
  await runAdb(adb, ['shell', 'input', 'tap', String(x), String(y)])
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const next = await runAdb(adb, ['shell', 'dumpsys', 'window'])
    if (!/\bmImeShowing=true\b/u.test(next)) {
      return true
    }
    await delay(100)
  }
  throw new Error('Hosted Android keyboard remained visible')
}

async function stageHostedAndroidAdversarialTerminalLinks(args, linkArgs, operations) {
  const activateTerminal = operations.activateTerminal ?? activateHostedWebViewControl
  const dismissKeyboard = operations.dismissKeyboard ?? dismissHostedAndroidKeyboardIfShown
  const runAdb = operations.runAdb ?? runAndroidAdb
  const stageWithInput = operations.stageWithInput ?? stageHostedAdversarialTerminalLinksWithInput
  const tapControl = operations.tapControl ?? tapHostedAndroidAccessibilityControl
  await activateTerminal(args.document, {
    kind: 'text',
    value: terminalTitle
  })
  const terminalHandle = await stageWithInput(linkArgs, async (command) => {
    await tapControl(args.emulator, terminalInputLabel, args.timeoutMs)
    await delay(250)
    await runAdb(args.emulator.adb, [
      'shell',
      'input',
      'text',
      hostedAndroidAdversarialTerminalInputText(command)
    ])
    await runAdb(args.emulator.adb, ['shell', 'input', 'keyevent', 'KEYCODE_ENTER'])
    await dismissKeyboard(args.emulator.adb, runAdb)
    await delay(500)
  })
  return terminalHandle
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
