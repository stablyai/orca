import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { PNG } from 'pngjs'
import {
  tapHostedIosAccessibilityControl,
  tapHostedIosAccessibilityControlAtLastOccurrence,
  tapHostedIosPoint,
  waitForHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlMatch
} from './hosted-ios-emulator-accessibility.mjs'
import { waitForNewHostedIosTerminalImageUpload } from './hosted-ios-document-upload.mjs'
import { readHostedRuntimeTerminalSnapshot } from './hosted-ios-photo-permission-denial.mjs'
import { allowHostedIosPasteIfRequested } from './hosted-ios-terminal-clipboard-paste.mjs'
import {
  readHostedWebViewState,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'

const execFileAsync = promisify(execFile)
const PHOTOS_APP_BUNDLE_ID = 'com.apple.mobileslideshow'
const PHOTOS_NOTIFICATION_DENIAL_LABELS = ['Don’t Allow', "Don't Allow"]
const PRIVILEGED_PAGE_MARKERS = ['orca-paste-', 'data:image/']

export async function copyHostedIosPhotoFixtureToClipboard(
  { deviceUdid, emulator, fixturePath, timeoutMs },
  operations = {}
) {
  const runCommand = operations.runCommand ?? execFileAsync
  const readFixture = operations.readFixture ?? readFile
  const tapControl = operations.tapControl ?? tapHostedIosAccessibilityControl
  const tapLastControl =
    operations.tapLastControl ?? tapHostedIosAccessibilityControlAtLastOccurrence
  const tapPoint = operations.tapPoint ?? tapHostedIosPoint
  const waitForControl = operations.waitForControl ?? waitForHostedIosAccessibilityControl
  const waitForMatch = operations.waitForMatch ?? waitForHostedIosAccessibilityControlMatch
  const stageFixture = operations.stageFixture ?? stageFreshHostedIosPhotoFixture
  await runCommand('xcrun', ['simctl', 'addmedia', deviceUdid, await stageFixture(fixturePath)])
  await runCommand('xcrun', ['simctl', 'launch', deviceUdid, PHOTOS_APP_BUNDLE_ID])

  await reachHostedIosPhotosLibrary({
    emulator,
    tapControl,
    tapPoint,
    timeoutMs,
    waitForControl,
    waitForMatch
  })
  let photoPoint
  for (let attempt = 0; attempt < 2; attempt++) {
    photoPoint = await tapLastControl(emulator, 'Photo', timeoutMs)
    try {
      await waitForControl(
        emulator,
        'Share',
        attempt === 0 ? Math.min(timeoutMs, 5_000) : timeoutMs
      )
      break
    } catch (error) {
      if (attempt === 1) {
        throw error
      }
      await reachHostedIosPhotosLibrary({
        emulator,
        tapControl,
        tapPoint,
        timeoutMs,
        waitForControl,
        waitForMatch
      })
    }
  }

  const sharePoint = await tapControl(emulator, 'Share', timeoutMs)
  const copyPoint = await tapControl(emulator, 'Copy Photo', timeoutMs)
  const returnPoint = await tapControl(emulator, 'Return to Orca', timeoutMs)
  await waitForControl(emulator, 'Paste', timeoutMs)

  const fixtureBytes = await readFixture(fixturePath)
  return {
    copyPoint,
    fixtureName: path.basename(fixturePath),
    fixturePixelIdentity: pngPixelIdentity(fixtureBytes),
    photoPoint,
    returnPoint,
    sharePoint
  }
}

export async function verifyHostedIosTerminalClipboardImagePaste(
  {
    deviceUdid,
    discoveryUrl,
    emulator,
    orcaCli,
    pairingRuntimeUserDataPath,
    terminalHandle,
    timeoutMs,
    worktree
  },
  operations = {}
) {
  const copyFixture = operations.copyFixture ?? copyHostedIosPhotoFixtureToClipboard
  const readTerminal = operations.readTerminal ?? readHostedRuntimeTerminalSnapshot
  const tapControl = operations.tapControl ?? tapHostedIosAccessibilityControl
  const allowPaste = operations.allowPaste ?? allowHostedIosPasteIfRequested
  const readUploadedFile = operations.readUploadedFile ?? readFile
  const readState = operations.readState ?? readHostedWebViewState
  const waitForDocument = operations.waitForDocument ?? waitForVisibleHostedWebView
  const terminalArgs = {
    orcaCli,
    pairingRuntimeUserDataPath,
    terminalHandle,
    worktree
  }
  const beforeTerminal = await readTerminal(terminalArgs)
  const clipboardFixture = await copyFixture({
    deviceUdid,
    emulator,
    fixturePath: path.join(worktree, 'mobile', 'assets', 'favicon.png'),
    timeoutMs
  })
  const activeSessionDocument = await waitForDocument({
    discoveryUrl,
    expectedText: 'Mobile Emulator',
    expectedHrefIncludes: '/session/',
    requireInteractiveControls: false,
    timeoutMs
  })
  const pasteControlPoint = await tapControl(emulator, 'Paste', timeoutMs)
  const pastePermissionPrompt = await allowPaste(emulator, tapControl)
  const upload = await waitForNewHostedIosTerminalImageUpload({
    beforeTerminal,
    description: 'Clipboard image',
    failureMessages: ['Paste failed', 'Image too large to paste'],
    readState,
    readTerminal,
    sessionDocument: activeSessionDocument,
    terminalArgs,
    timeoutMs
  })
  const uploadedBytes = await readUploadedFile(upload.path)
  const uploadedPixelIdentity = pngPixelIdentity(uploadedBytes)
  if (!samePixelIdentity(uploadedPixelIdentity, clipboardFixture.fixturePixelIdentity)) {
    throw new Error('Clipboard image upload did not preserve the fixture pixels')
  }
  const pageState = await readState(activeSessionDocument)
  assertNoPrivilegedClipboardImageState(pageState, clipboardFixture, uploadedBytes, upload.path)
  return {
    evidence: {
      copyPoint: clipboardFixture.copyPoint,
      fixtureName: clipboardFixture.fixtureName,
      height: uploadedPixelIdentity.height,
      pasteControlPoint,
      pastePermissionPrompt,
      pixelSha256: uploadedPixelIdentity.sha256,
      privilegedPageMarkers: 'absent',
      route: activeSessionDocument.href,
      size: uploadedBytes.byteLength,
      terminalPathInjected: true,
      width: uploadedPixelIdentity.width
    },
    sessionDocument: activeSessionDocument
  }
}

// Why: Photos orders the library by capture date, which addmedia takes from the file's creation
// time. A checked-in fixture is older than existing photos, so "last Photo" would pick another
// asset. Writing the bytes (never copyFile, which clones the birth time on APFS) dates it now.
export async function stageFreshHostedIosPhotoFixture(fixturePath, operations = {}) {
  const readFixture = operations.readFixture ?? readFile
  const writeFixture = operations.writeFixture ?? writeFile
  const createDirectory = operations.createDirectory ?? mkdtemp
  const directory = await createDirectory(path.join(tmpdir(), 'orca-hosted-photo-fixture-'))
  const stagedPath = path.join(directory, path.basename(fixturePath))
  await writeFixture(stagedPath, await readFixture(fixturePath))
  return stagedPath
}

async function reachHostedIosPhotosLibrary({
  emulator,
  tapControl,
  tapPoint,
  timeoutMs,
  waitForControl,
  waitForMatch
}) {
  let surface
  for (let attempt = 0; attempt < 5; attempt++) {
    surface = await waitForMatch(
      emulator,
      ['Share', 'Select', 'Continue', ...PHOTOS_NOTIFICATION_DENIAL_LABELS],
      Math.min(timeoutMs, 15_000)
    )
    if (surface.label === 'Share' || surface.label === 'Select') {
      break
    }
    await tapPoint(emulator, surface)
  }
  if (!surface || (surface.label !== 'Share' && surface.label !== 'Select')) {
    throw new Error('Photos onboarding did not reach the Library')
  }
  if (surface.label === 'Share') {
    await tapControl(emulator, 'Back', timeoutMs)
    await waitForControl(emulator, 'Select', timeoutMs)
  }
}

export function pngPixelIdentity(bytes) {
  const decoded = PNG.sync.read(bytes)
  return {
    height: decoded.height,
    sha256: createHash('sha256').update(decoded.data).digest('hex'),
    width: decoded.width
  }
}

function samePixelIdentity(left, right) {
  return left.height === right.height && left.width === right.width && left.sha256 === right.sha256
}

function assertNoPrivilegedClipboardImageState(state, fixture, uploadedBytes, uploadedPath) {
  const markers = [
    ...PRIVILEGED_PAGE_MARKERS,
    fixture.fixtureName,
    fixture.fixturePixelIdentity.sha256,
    uploadedPath,
    uploadedBytes.toString('base64').slice(0, 16)
  ]
  const marker = markers.find((candidate) => state.bodyText.includes(candidate))
  if (marker) {
    throw new Error(`Clipboard image exposed privileged page marker: ${marker}`)
  }
}
