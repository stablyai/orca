import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import {
  describeHostedTerminalLinkPoint,
  readHostedTerminalLinkPoints
} from './hosted-terminal-link-locator.mjs'

const execFileAsync = promisify(execFile)
const terminalTitle = 'Mobile Emulator'
const terminalScriptName = 'orca-mobile-terminal-links.cjs'
const terminalJavaScriptMarker = '__ORCA_HOSTED_TERMINAL_LINK_EXECUTED__'
const LIVE_STAGE_ATTEMPTS = 3
const LIVE_STAGE_ATTEMPT_TIMEOUT_MS = 5_000
const NATIVE_LINK_ACTIVATION_ATTEMPTS = 3
const NATIVE_LINK_ACTIVATION_TIMEOUT_MS = 5_000
export const HOSTED_TERMINAL_HTTP_LINK_LABEL = 'ORCA_HTTP'
export const HOSTED_TERMINAL_JAVASCRIPT_LINK_LABEL = 'ORCA_JS'
export const HOSTED_TERMINAL_FILE_LINK_LABEL = 'ORCA_FILE'

export async function verifyHostedAdversarialTerminalLinks(
  {
    discoveryUrl,
    document,
    emulator,
    orcaCli,
    pairingRuntimeUserDataPath,
    positiveFilePath,
    probe,
    tapPoint,
    terminalHandle,
    timeoutMs,
    worktree
  },
  operations = {}
) {
  const writeLinks = operations.writeLinks ?? stageHostedAdversarialTerminalLinks
  const readPoints = operations.readPoints ?? readHostedTerminalLinkPoints
  const waitForDocument = operations.waitForDocument ?? waitForVisibleHostedWebView
  const readState = operations.readState ?? readHostedTerminalLinkSecurityState
  const settle = operations.settle ?? delay
  const activateTerminal = operations.activateTerminal ?? activateHostedWebViewControl
  const enableDiagnostics = operations.enableDiagnostics ?? enableHostedTerminalDiagnostics
  const prepareFileTap = operations.prepareFileTap

  await enableDiagnostics(document)
  const resolvedTerminalHandle = await writeLinks({
    orcaCli,
    pairingRuntimeUserDataPath,
    positiveFilePath,
    probePort: probe.port,
    probeToken: probe.token,
    terminalHandle,
    timeoutMs,
    worktree
  })
  const sessionDocument = await openHostedAdversarialTerminalFileLink({
    discoveryUrl,
    document,
    emulator,
    positiveFilePath,
    prepareFileTap,
    readPoints,
    tapPoint,
    timeoutMs,
    waitForDocument
  })
  await activateTerminal(sessionDocument, {
    kind: 'text',
    value: terminalTitle
  })
  await settle(750)
  const javascriptPoint = (await readPoints(sessionDocument)).javascript
  await tapPoint(emulator, javascriptPoint)
  await settle(500)
  const state = await readState(sessionDocument)
  const safety = hostedAdversarialTerminalLinkSafetyEvidence({
    observations: probe.observations,
    state
  })
  return {
    evidence: {
      ...safety,
      fileLinkOpenedAfterNativeTap: true,
      httpLinkRequestedWithoutTap: false,
      javascriptTapPoint: javascriptPoint,
      terminalHandle: resolvedTerminalHandle
    },
    sessionDocument
  }
}

async function openHostedAdversarialTerminalFileLink({
  discoveryUrl,
  document,
  emulator,
  positiveFilePath,
  prepareFileTap,
  readPoints,
  tapPoint,
  timeoutMs,
  waitForDocument
}) {
  let lastError
  let lastPoint
  for (let attempt = 0; attempt < NATIVE_LINK_ACTIVATION_ATTEMPTS; attempt += 1) {
    try {
      await prepareFileTap?.()
      const points = await readPoints(document)
      lastPoint = attempt % 2 === 1 ? (points.fileAlternate ?? points.file) : points.file
      await tapPoint(emulator, lastPoint)
      return await waitForDocument({
        discoveryUrl,
        expectedText: positiveFilePath,
        expectedHrefIncludes: '/session/',
        requireInteractiveControls: false,
        timeoutMs: Math.min(timeoutMs, NATIVE_LINK_ACTIVATION_TIMEOUT_MS)
      })
    } catch (error) {
      lastError = error
    }
  }
  const diagnostic = await describeHostedTerminalLinkPoint(
    document,
    lastPoint ?? { x: 0.5, y: 0.5 }
  ).catch(() => null)
  const failure = lastError instanceof Error ? lastError.message.slice(0, 1_000) : String(lastError)
  throw new Error(
    `Hosted terminal file link did not activate: ${JSON.stringify({
      diagnostic,
      failure,
      lastPoint
    })}`,
    { cause: lastError }
  )
}

export function hostedAdversarialTerminalLinkSafetyEvidence({ observations, state }) {
  if (
    state?.javascriptMarkerPresent !== false ||
    state.javascriptMarkerValue !== null ||
    !state.href.includes('/session/')
  ) {
    throw new Error(`Hosted terminal javascript link executed: ${JSON.stringify(state)}`)
  }
  if (observations.length > 0) {
    throw new Error(`Hosted terminal javascript link escaped: ${observations.join(', ')}`)
  }
  return {
    javascriptLinkExecuted: false,
    javascriptLinkEscaped: false,
    routeRetained: true
  }
}

export function hostedAdversarialTerminalLinkCommand(
  probePort,
  probeToken,
  positiveFilePath = '001-adversarial.md'
) {
  const encoded = hostedAdversarialTerminalLinkPayload(probePort, probeToken, positiveFilePath)
  return `node -e "process.stdout.write(Buffer.from('${encoded}','base64'))"`
}

function hostedAdversarialTerminalLinkPayload(
  probePort,
  probeToken,
  positiveFilePath,
  stageMarker = ''
) {
  if (
    !Number.isInteger(probePort) ||
    probePort < 1 ||
    probePort > 65_535 ||
    !/^[A-Z0-9-]{1,128}$/u.test(probeToken) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(positiveFilePath) ||
    positiveFilePath.includes('..') ||
    (stageMarker && !/^_ORCA_STAGE_[a-f0-9]{16}$/u.test(stageMarker))
  ) {
    throw new Error('Hosted terminal link probe is invalid')
  }
  const httpUrl = `http://127.0.0.1:${probePort}/terminal-link/${probeToken}`
  const javascriptUrl = `javascript:globalThis.${terminalJavaScriptMarker}='executed'`
  const output = [
    '\u001B[2J\u001B[H\u001B[999;1H\u001B[10A',
    ...repeatedOscRows(javascriptUrl, HOSTED_TERMINAL_JAVASCRIPT_LINK_LABEL),
    '\r\n',
    ...repeatedOscRows(positiveFilePath, HOSTED_TERMINAL_FILE_LINK_LABEL),
    '\r\n',
    ...repeatedOscRows(httpUrl, HOSTED_TERMINAL_HTTP_LINK_LABEL, stageMarker),
    '\r\n\r\n'
  ].join('')
  return Buffer.from(output).toString('base64')
}

export async function stageHostedAdversarialTerminalLinks({
  absoluteScriptPath = false,
  orcaCli,
  pairingRuntimeUserDataPath,
  positiveFilePath,
  probePort,
  probeToken,
  terminalHandle,
  timeoutMs,
  worktree
}) {
  const prepared = await prepareHostedAdversarialTerminalLinks({
    absoluteScriptPath,
    orcaCli,
    pairingRuntimeUserDataPath,
    positiveFilePath,
    probePort,
    probeToken,
    terminalHandle,
    timeoutMs,
    worktree
  })
  const send = await runRuntimeCli(
    orcaCli,
    [
      'terminal',
      'send',
      '--terminal',
      prepared.terminalHandle,
      '--text',
      prepared.command,
      '--enter',
      '--json'
    ],
    worktree,
    prepared.environment
  )
  if (send.result?.send?.accepted !== true) {
    throw new Error(
      `Temporary Desktop terminal rejected adversarial link output: ${
        send.result?.send?.refusedReason ?? 'unknown'
      }`
    )
  }
  await waitForStagedHostedAdversarialTerminalLinks(prepared, timeoutMs)
  return prepared.terminalHandle
}

export async function stageHostedAdversarialTerminalLinksWithInput(
  args,
  inputCommand,
  operations = {}
) {
  const prepare = operations.prepare ?? prepareHostedAdversarialTerminalLinks
  const waitForStage = operations.waitForStage ?? waitForStagedHostedAdversarialTerminalLinks
  const prepared = await prepare(args)
  let lastError
  for (let attempt = 0; attempt < LIVE_STAGE_ATTEMPTS; attempt += 1) {
    await inputCommand(prepared.command)
    try {
      await waitForStage(prepared, Math.min(args.timeoutMs, LIVE_STAGE_ATTEMPT_TIMEOUT_MS))
      return prepared.terminalHandle
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function prepareHostedAdversarialTerminalLinks({
  absoluteScriptPath = false,
  orcaCli,
  pairingRuntimeUserDataPath,
  positiveFilePath,
  probePort,
  probeToken,
  terminalHandle,
  timeoutMs,
  worktree
}) {
  const environment = {
    ...process.env,
    ORCA_DEV_USER_DATA_PATH: pairingRuntimeUserDataPath,
    ORCA_USER_DATA_PATH: pairingRuntimeUserDataPath
  }
  let resolvedTerminalHandle = terminalHandle
  if (!resolvedTerminalHandle) {
    const list = await runRuntimeCli(
      orcaCli,
      ['terminal', 'list', '--worktree', `path:${worktree}`, '--json'],
      worktree,
      environment
    )
    resolvedTerminalHandle = (list.result?.terminals ?? []).find(
      (candidate) => candidate.title === terminalTitle
    )?.handle
  }
  if (!resolvedTerminalHandle) {
    throw new Error('Temporary Desktop terminal was not found')
  }
  const scriptPath = path.join(worktree, '.git', terminalScriptName)
  const stageMarker = `_ORCA_STAGE_${randomBytes(8).toString('hex')}`
  const encoded = hostedAdversarialTerminalLinkPayload(
    probePort,
    probeToken,
    positiveFilePath,
    stageMarker
  )
  const write = `process.stdout.write(Buffer.from('${encoded}', 'base64'))`
  const script = `${write}\n`
  await writeFile(scriptPath, script, { mode: 0o600 })
  await waitForTerminalTail({
    environment,
    orcaCli,
    predicate: (tail) => tail.some((line) => line.trim().length > 0),
    terminalHandle: resolvedTerminalHandle,
    timeoutMs,
    worktree
  })
  return {
    command: `node ${JSON.stringify(
      absoluteScriptPath ? scriptPath : path.relative(worktree, scriptPath)
    )}`,
    environment,
    orcaCli,
    stageMarker,
    terminalHandle: resolvedTerminalHandle,
    worktree
  }
}

async function waitForStagedHostedAdversarialTerminalLinks(prepared, timeoutMs) {
  await waitForTerminalTail({
    environment: prepared.environment,
    orcaCli: prepared.orcaCli,
    predicate: (tail) =>
      tail.some((line) => line.includes(prepared.stageMarker)) &&
      [HOSTED_TERMINAL_FILE_LINK_LABEL, HOSTED_TERMINAL_JAVASCRIPT_LINK_LABEL].every((label) =>
        tail.some((line) => line.includes(label))
      ),
    terminalHandle: prepared.terminalHandle,
    timeoutMs,
    worktree: prepared.worktree
  })
}

async function readHostedTerminalLinkSecurityState(document) {
  const expression = `JSON.stringify({
    href: String(location.href),
    javascriptMarkerPresent: Object.prototype.hasOwnProperty.call(
      globalThis,
      ${JSON.stringify(terminalJavaScriptMarker)}
    ),
    javascriptMarkerValue: globalThis[${JSON.stringify(terminalJavaScriptMarker)}] ?? null
  })`
  return JSON.parse(await evaluateHostedDocumentWithRetry(document, expression, WebSocket))
}

export function enableHostedTerminalDiagnostics(document) {
  return evaluateHostedDocumentWithRetry(
    document,
    `globalThis.__orcaCaptureMobileTerminalDiagnostics = true; 'enabled'`,
    WebSocket
  )
}

function repeatedOscRows(uri, label, finalSuffix = '') {
  return [label, `${label}${finalSuffix}`].map((rowLabel) => {
    return `\u001B]8;;${uri}\u001B\\${rowLabel}\u001B]8;;\u001B\\\r\n`
  })
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

async function waitForTerminalTail({
  environment,
  orcaCli,
  predicate,
  terminalHandle,
  timeoutMs,
  worktree
}) {
  const deadline = Date.now() + Math.min(timeoutMs, 15_000)
  let tail = []
  while (Date.now() < deadline) {
    const read = await runRuntimeCli(
      orcaCli,
      ['terminal', 'read', '--terminal', terminalHandle, '--limit', '200', '--json'],
      worktree,
      environment
    )
    tail = read.result?.terminal?.tail ?? []
    if (predicate(tail)) {
      return
    }
    await delay(100)
  }
  throw new Error(`Temporary Desktop terminal did not stage links: ${tail.slice(-4).join(' | ')}`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
