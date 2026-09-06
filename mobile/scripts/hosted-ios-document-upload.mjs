import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  tapHostedIosAccessibilityControl,
  tapHostedIosAccessibilityControlByLabelPrefix,
  tapHostedIosAccessibilityControlByLabelPrefixAtPosition,
  waitForHostedIosAccessibilityLabelToDisappear,
  waitForHostedIosAccessibilityControl
} from './hosted-ios-emulator-accessibility.mjs'
import { longPressHostedIosPoint } from './hosted-ios-emulator-long-press.mjs'
import { readHostedRuntimeTerminalSnapshot } from './hosted-ios-photo-permission-denial.mjs'
import { readHostedWebViewControlPoint } from './hosted-webview-control-point.mjs'
import { dispatchHostedWebViewLongPress } from './hosted-webview-long-press.mjs'
import {
  readHostedWebViewState,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'

const execFileAsync = promisify(execFile)
export const HOSTED_IOS_DOCUMENT_FIXTURE_NAME = 'orca-document-upload-fixture.png'
const LOCAL_FILE_PROVIDER_GROUP = 'group.com.apple.FileProvider.LocalStorage'
const PRIVILEGED_PAGE_MARKERS = ['orca-paste-', 'data:image/']
// Why lazy: two pasted paths can abut in the joined tail; greedy segments would fuse them into one.
const UPLOADED_PATH_PATTERN =
  /\/(?:private\/)?var\/folders\/(?:[^/\s]+\/)+?T\/orca-paste-[0-9]+-[0-9a-f-]+\.png/gi

export async function seedHostedIosDocumentFixture({ deviceUdid, fixturePath }, operations = {}) {
  const runCommand = operations.runCommand ?? execFileAsync
  const copy = operations.copy ?? copyFile
  const createDirectory = operations.createDirectory ?? mkdir
  const readFixture = operations.readFixture ?? readFile
  const touch = operations.touch ?? utimes
  const { stdout } = await runCommand(
    'xcrun',
    ['simctl', 'get_app_container', deviceUdid, 'com.apple.DocumentsApp', 'groups'],
    { encoding: 'utf8' }
  )
  const groupPath = parseLocalFileProviderGroupPath(String(stdout))
  const storagePath = path.join(groupPath, 'File Provider Storage')
  const destinationPath = path.join(storagePath, HOSTED_IOS_DOCUMENT_FIXTURE_NAME)
  await createDirectory(storagePath, { recursive: true })
  await copy(fixturePath, destinationPath)
  const now = new Date()
  await touch(destinationPath, now, now)
  const fixture = await readFixture(fixturePath)
  return {
    destinationPath,
    fixtureName: HOSTED_IOS_DOCUMENT_FIXTURE_NAME,
    sha256: sha256(fixture),
    size: fixture.byteLength
  }
}

export async function removeHostedIosDocumentFixture(destinationPath, remove = rm) {
  await remove(destinationPath, { force: true })
}

export function parseLocalFileProviderGroupPath(output) {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${LOCAL_FILE_PROVIDER_GROUP}\t`))
  const groupPath = line?.slice(LOCAL_FILE_PROVIDER_GROUP.length + 1).trim()
  if (!groupPath || !path.isAbsolute(groupPath)) {
    throw new Error('Simulator Local File Provider container was not found')
  }
  return groupPath
}

export async function selectHostedIosDocumentFixture(
  emulator,
  fixtureName,
  timeoutMs,
  operations = {}
) {
  const tapControl = operations.tapControl ?? tapHostedIosAccessibilityControl
  const tapByPrefix = operations.tapByPrefix ?? tapHostedIosAccessibilityControlByLabelPrefix
  const tapFixture =
    operations.tapFixture ?? tapHostedIosAccessibilityControlByLabelPrefixAtPosition
  const waitForPickerDismissal =
    operations.waitForPickerDismissal ?? waitForHostedIosAccessibilityLabelToDisappear
  const fixtureLabelPrefix = path.parse(fixtureName).name
  const selectVisibleFixture = async (selectionTimeoutMs) => {
    const point = await tapFixture(
      emulator,
      fixtureLabelPrefix,
      { x: 0.5, y: 0.25 },
      selectionTimeoutMs
    )
    await waitForPickerDismissal(emulator, 'Browse', Math.min(selectionTimeoutMs, 3_000))
    return point
  }
  try {
    return await selectVisibleFixture(Math.min(timeoutMs, 5_000))
  } catch {
    await tapControl(emulator, 'Browse', Math.min(timeoutMs, 5_000))
  }
  try {
    return await selectVisibleFixture(Math.min(timeoutMs, 5_000))
  } catch {
    await tapByPrefix(emulator, 'On My iPhone', Math.min(timeoutMs, 5_000))
  }
  return selectVisibleFixture(timeoutMs)
}

export async function verifyHostedIosDocumentUpload(
  {
    discoveryUrl,
    documentFixture,
    emulator,
    orcaCli,
    pairingRuntimeUserDataPath,
    sessionDocument,
    terminalHandle,
    timeoutMs,
    worktree
  },
  operations = {}
) {
  const readControlPoint = operations.readControlPoint ?? readHostedWebViewControlPoint
  const readAccessibilityPoint =
    operations.readAccessibilityPoint ?? waitForHostedIosAccessibilityControl
  const openPicker = operations.openPicker ?? openHostedIosDocumentPicker
  const selectFixture = operations.selectFixture ?? selectHostedIosDocumentFixture
  const readTerminal = operations.readTerminal ?? readHostedRuntimeTerminalSnapshot
  const readState = operations.readState ?? readHostedWebViewState
  const waitForDocument = operations.waitForDocument ?? waitForVisibleHostedWebView
  const readUploadedFile = operations.readUploadedFile ?? readFile
  const fileStat = operations.fileStat ?? stat
  const terminalArgs = {
    orcaCli,
    pairingRuntimeUserDataPath,
    terminalHandle,
    worktree
  }
  const beforeTerminal = await readTerminal(terminalArgs)
  const attachControlPoint = await readControlPoint(sessionDocument, 'Attach a photo')
  const attachAccessibilityPoint = await readAccessibilityPoint(
    emulator,
    'Attach a photo',
    timeoutMs
  )
  const pickerActivation = await openPicker({
    document: sessionDocument,
    emulator,
    point: attachControlPoint
  })
  let selectedFilePoint
  try {
    selectedFilePoint = await selectFixture(emulator, documentFixture.fixtureName, timeoutMs)
  } catch (error) {
    throw new Error(
      `Document picker did not open (DOM ${formatPoint(attachControlPoint)}, accessibility ${formatPoint(attachAccessibilityPoint)}): ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const upload = await waitForNewHostedIosTerminalImageUpload({
    beforeTerminal,
    description: 'Selected document',
    failureMessages: ['Attach failed', 'Image too large to attach'],
    readState,
    readTerminal,
    sessionDocument,
    terminalArgs,
    timeoutMs
  })
  const uploadedBytes = await readUploadedFile(upload.path)
  const uploadedStat = await fileStat(upload.path)
  const uploadedSha256 = sha256(uploadedBytes)
  if (
    uploadedBytes.byteLength !== documentFixture.size ||
    uploadedStat.size !== documentFixture.size ||
    uploadedSha256 !== documentFixture.sha256
  ) {
    throw new Error('Selected document upload did not preserve the fixture bytes')
  }
  const pageState = await readState(sessionDocument)
  assertNoPrivilegedDocumentState(pageState, documentFixture, uploadedBytes)
  const activeSessionDocument = await waitForDocument({
    discoveryUrl,
    expectedText: 'Mobile Emulator',
    expectedHrefIncludes: '/session/',
    requireInteractiveControls: false,
    timeoutMs
  })
  return {
    evidence: {
      attachControlPoint,
      attachAccessibilityPoint,
      fixtureName: documentFixture.fixtureName,
      pickerActivation,
      privilegedPageMarkers: 'absent',
      route: activeSessionDocument.href,
      selectedFilePoint,
      sha256: uploadedSha256,
      size: uploadedBytes.byteLength,
      terminalPathInjected: true
    },
    sessionDocument: activeSessionDocument
  }
}

export function uploadedPathsFromTerminalSnapshot(snapshot) {
  return [...String(snapshot.join('')).matchAll(UPLOADED_PATH_PATTERN)].map((match) => match[0])
}

export async function waitForNewHostedIosTerminalImageUpload({
  beforeTerminal,
  description,
  failureMessages,
  readState,
  readTerminal,
  sessionDocument,
  terminalArgs,
  timeoutMs
}) {
  const beforePaths = new Set(uploadedPathsFromTerminalSnapshot(beforeTerminal))
  const deadline = Date.now() + timeoutMs
  let lastTerminal = beforeTerminal
  let lastPageText = ''
  while (Date.now() < deadline) {
    lastTerminal = await readTerminal(terminalArgs)
    const pathValue = uploadedPathsFromTerminalSnapshot(lastTerminal).find(
      (candidate) => !beforePaths.has(candidate)
    )
    if (pathValue) {
      return { path: pathValue, terminal: lastTerminal }
    }
    lastPageText = (await readState(sessionDocument)).bodyText
    const failure = failureMessages.find((message) => lastPageText.includes(message))
    if (failure) {
      throw new Error(`${description} upload failed in the native shell: ${failure}`)
    }
    await delay(150)
  }
  throw new Error(
    `${description} path did not reach Desktop terminal: ${lastTerminal.slice(-8).join(' | ')}; page: ${lastPageText.slice(-160)}`
  )
}

function assertNoPrivilegedDocumentState(state, fixture, uploadedBytes) {
  const markers = [
    ...PRIVILEGED_PAGE_MARKERS,
    fixture.fixtureName,
    fixture.sha256,
    uploadedBytes.toString('base64').slice(0, 16)
  ]
  const marker = markers.find((candidate) => state.bodyText.includes(candidate))
  if (marker) {
    throw new Error(`Selected document exposed privileged page marker: ${marker}`)
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatPoint(point) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`
}

export async function openHostedIosDocumentPicker(args, operations = {}) {
  const longPressPoint = operations.longPressPoint ?? longPressHostedIosPoint
  const waitForPicker = operations.waitForPicker ?? waitForHostedIosAccessibilityControl
  const dispatchWebLongPress = operations.dispatchWebLongPress ?? dispatchHostedWebViewLongPress
  for (let attempt = 0; attempt < 2; attempt++) {
    await longPressPoint(args.emulator, args.point)
    try {
      await waitForPicker(args.emulator, 'Browse', 1_000)
      return 'native-long-press'
    } catch {}
    await dispatchWebLongPress(args.document, 'Attach a photo')
    try {
      await waitForPicker(args.emulator, 'Browse', 5_000)
      return 'native-touch-plus-web-responder'
    } catch (error) {
      if (attempt === 1) {
        throw error
      }
    }
  }
  throw new Error('Document picker activation exhausted')
}
