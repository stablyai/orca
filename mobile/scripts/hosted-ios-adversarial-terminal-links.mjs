import { WebSocket } from 'ws'
import {
  stageHostedAdversarialTerminalLinks,
  verifyHostedAdversarialTerminalLinks
} from './hosted-adversarial-terminal-links.mjs'
import {
  tapHostedIosAccessibilityControl,
  tapHostedIosPoint,
  waitForHostedIosAccessibilityControl
} from './hosted-ios-emulator-accessibility.mjs'
import {
  evaluateHostedDocumentWithRetry,
  readHostedWebViewTextPoint
} from './hosted-webview-cdp-session.mjs'
import { readHostedTerminalLinkPoints } from './hosted-terminal-link-locator.mjs'

const terminalTitle = 'Mobile Emulator'
const terminalHeaderDismissPoint = { x: 0.5, y: 0.14 }

export function verifyHostedIosAdversarialTerminalLinks(args, operations = {}) {
  const { stagedTerminalHandle, ...verifyArgs } = args
  const verifyLinks = operations.verifyLinks ?? verifyHostedAdversarialTerminalLinks
  let yOffset = 0
  return verifyLinks(
    {
      ...verifyArgs,
      terminalHandle: stagedTerminalHandle ?? verifyArgs.terminalHandle,
      tapPoint: tapHostedIosPoint
    },
    {
      prepareFileTap: () => prepareHostedIosTerminalLinkTap(args),
      readPoints: async (document) => {
        const alignment = await readHostedIosTerminalLinkPoints(args, document)
        yOffset = alignment.yOffset
        return alignment.points
      },
      writeLinks: (linkArgs) =>
        stagedTerminalHandle ??
        stageHostedIosAdversarialTerminalLinks(args, linkArgs, operations.stageLinks)
    }
  ).then((result) => ({ ...result, yOffset }))
}

async function prepareHostedIosTerminalLinkTap(args) {
  await tapHostedIosAccessibilityControl(args.emulator, 'Done', 1_000).catch(() => {})
  await tapHostedIosPoint(args.emulator, terminalHeaderDismissPoint)
  await evaluateHostedDocumentWithRetry(
    args.document,
    `document.activeElement?.blur(); 'blurred'`,
    WebSocket
  )
  await waitForHostedIosExpandedViewport(args.document, args.timeoutMs)
}

async function readHostedIosTerminalLinkPoints(args, document) {
  const linkPoints = await waitForHostedIosTerminalLinkPoints(document, args.timeoutMs)
  const [pageTitlePoint, nativeTitlePoint] = await Promise.all([
    readHostedWebViewTextPoint(document, terminalTitle),
    waitForHostedIosAccessibilityControl(args.emulator, terminalTitle, args.timeoutMs)
  ])
  return alignHostedIosTerminalLinkPoints(linkPoints, pageTitlePoint, nativeTitlePoint)
}

async function waitForHostedIosTerminalLinkPoints(document, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 5_000)
  let lastError = new Error('Hosted terminal link corpus is unavailable')
  while (Date.now() < deadline) {
    try {
      return await readHostedTerminalLinkPoints(document)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw lastError
}

export function alignHostedIosTerminalLinkPoints(points, pageTitlePoint, nativeTitlePoint) {
  const yOffset = nativeTitlePoint.y - pageTitlePoint.y
  const aligned = Object.fromEntries(
    Object.entries(points).map(([kind, point]) => [kind, { x: point.x, y: point.y + yOffset }])
  )
  if (
    !Number.isFinite(yOffset) ||
    Object.values(aligned).some(
      (point) =>
        !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.y < 0 || point.y > 1
    )
  ) {
    throw new Error('Hosted iOS terminal link alignment is invalid')
  }
  return { points: aligned, yOffset }
}

export function alignHostedIosSessionPoint(point, yOffset, document) {
  const aligned = document.href.includes('/session/') ? { x: point.x, y: point.y + yOffset } : point
  if (
    !Number.isFinite(aligned.x) ||
    !Number.isFinite(aligned.y) ||
    aligned.x < 0 ||
    aligned.x > 1 ||
    aligned.y < 0 ||
    aligned.y > 1
  ) {
    throw new Error('Hosted iOS session point alignment is invalid')
  }
  return aligned
}

async function stageHostedIosAdversarialTerminalLinks(
  args,
  linkArgs,
  stageLinks = stageHostedAdversarialTerminalLinks
) {
  await prepareHostedIosTerminalLinkTap(args)
  return stageLinks({
    ...linkArgs,
    absoluteScriptPath: true
  })
}

async function waitForHostedIosExpandedViewport(document, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 5_000)
  while (Date.now() < deadline) {
    const viewport = JSON.parse(
      await evaluateHostedDocumentWithRetry(
        document,
        `JSON.stringify({ innerHeight: Number(innerHeight), screenHeight: Number(screen.height) })`,
        WebSocket
      )
    )
    if (viewport.innerHeight / viewport.screenHeight > 0.75) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Hosted iOS terminal keyboard did not dismiss')
}
