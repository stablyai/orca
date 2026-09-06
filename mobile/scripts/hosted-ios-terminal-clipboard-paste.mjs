import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tapHostedIosAccessibilityControl } from './hosted-ios-emulator-accessibility.mjs'
import {
  activateHostedWebViewControl,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'

const execFileAsync = promisify(execFile)
export const CLIPBOARD_MARKER = 'ORCA_HOSTED_CLIPBOARD_TEXT_PASTE'

export async function verifyHostedIosTerminalClipboardPaste(
  {
    deviceUdid,
    discoveryUrl,
    emulator,
    expectedWorkspace,
    orcaCli,
    pairingRuntimeUserDataPath,
    timeoutMs,
    workspaceDocument,
    worktree
  },
  operations = {}
) {
  const writePasteboard = operations.writePasteboard ?? writeHostedIosSimulatorPasteboard
  const activateWorkspace = operations.activateWorkspace ?? activateHostedWorkspaceRow
  const waitForDocument = operations.waitForDocument ?? waitForVisibleHostedWebView
  const tapControl = operations.tapControl ?? tapHostedIosAccessibilityControl
  const readTerminal = operations.readTerminal ?? waitForHostedTerminalMarker

  await writePasteboard(deviceUdid, CLIPBOARD_MARKER)
  await activateWorkspace(
    workspaceDocument,
    expectedWorkspace,
    activateHostedWebViewControl,
    timeoutMs,
    () =>
      waitForDocument({
        discoveryUrl,
        expectedText: expectedWorkspace,
        timeoutMs
      })
  )
  const sessionDocument = await waitForDocument({
    discoveryUrl,
    expectedText: 'Mobile Emulator',
    expectedHrefIncludes: '/session/',
    requireInteractiveControls: false,
    timeoutMs
  })
  let activationAttempts = 0
  let pasteControlPoint = null
  let pastePermissionPrompt = 'not-shown'
  let terminalHandle = null
  let terminalError = null
  while (activationAttempts < 3 && !terminalHandle) {
    activationAttempts += 1
    pasteControlPoint = await tapControl(emulator, 'Paste', timeoutMs)
    const permissionPrompt = await allowHostedIosPasteIfRequested(emulator, tapControl)
    if (permissionPrompt === 'allowed') {
      pastePermissionPrompt = permissionPrompt
    }
    try {
      terminalHandle = await readTerminal({
        marker: CLIPBOARD_MARKER,
        orcaCli,
        pairingRuntimeUserDataPath,
        timeoutMs: Math.min(timeoutMs, 10_000),
        worktree
      })
    } catch (error) {
      terminalError = error
    }
  }
  if (!terminalHandle || !pasteControlPoint) {
    throw terminalError ?? new Error('Hosted Paste control did not reach the Desktop terminal')
  }
  return {
    evidence: {
      activationAttempts,
      marker: CLIPBOARD_MARKER,
      pasteControlPoint,
      pastePermissionPrompt,
      route: sessionDocument.href,
      terminalHandle
    },
    sessionDocument
  }
}

export function writeHostedIosSimulatorPasteboard(deviceUdid, text, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('xcrun', ['simctl', 'pbcopy', deviceUdid], {
      stdio: ['pipe', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8 * 1024)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Simulator pasteboard write failed (${code}): ${stderr.trim()}`))
      }
    })
    child.stdin?.end(text)
  })
}

export async function allowHostedIosPasteIfRequested(emulator, tapControl) {
  try {
    await tapControl(emulator, 'Allow Paste', 3_000)
    return 'allowed'
  } catch {
    return 'not-shown'
  }
}

async function waitForHostedTerminalMarker({
  marker,
  orcaCli,
  pairingRuntimeUserDataPath,
  timeoutMs,
  worktree
}) {
  const environment = {
    ...process.env,
    ORCA_DEV_USER_DATA_PATH: pairingRuntimeUserDataPath,
    ORCA_USER_DATA_PATH: pairingRuntimeUserDataPath
  }
  const list = await runRuntimeCli(
    orcaCli,
    ['terminal', 'list', '--worktree', `path:${worktree}`, '--json'],
    worktree,
    environment
  )
  const terminals = list.result?.terminals ?? []
  const terminal = terminals.find((candidate) => candidate.title === 'Mobile Emulator')
  if (!terminal?.handle) {
    throw new Error('Temporary Desktop terminal was not found')
  }
  const deadline = Date.now() + timeoutMs
  let lastTail = []
  while (Date.now() < deadline) {
    const read = await runRuntimeCli(
      orcaCli,
      ['terminal', 'read', '--terminal', terminal.handle, '--limit', '200', '--json'],
      worktree,
      environment
    )
    lastTail = read.result?.terminal?.tail ?? []
    if (lastTail.some((line) => line.includes(marker))) {
      return terminal.handle
    }
    await delay(150)
  }
  throw new Error(
    `Clipboard marker did not reach Desktop terminal: ${lastTail.slice(-8).join(' | ')}`
  )
}

async function runRuntimeCli(command, args, cwd, env) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000
  })
  const parsed = JSON.parse(stdout)
  if (parsed.ok !== true) {
    throw new Error(parsed.error?.message ?? 'Temporary Desktop CLI request failed')
  }
  return parsed
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
