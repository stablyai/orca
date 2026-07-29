import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { writeFileAtomically } from './codex-accounts/fs-utils'
import { getCanonicalUserDataPath } from './persistence'
import { MacosTccPromptWatch } from './macos-tcc-prompt-watch'

/**
 * Surfaces Full Disk Access guidance only to users macOS is actually prompting
 * (#9756), instead of nudging every Mac user. Counts Orca-attributed TCC
 * dialogs across launches and tells the renderer when the first one lands.
 */

/** Why: the first detected dialog identifies an affected user; the notice remains one-time. */
export const TCC_PROMPT_NOTICE_THRESHOLD = 1

/** Why: preserve detection when Electron never emits `ready-to-show` without competing with startup. */
export const TCC_PROMPT_WATCH_START_FALLBACK_MS = 10_000

export const TCC_PROMPT_NOTICE_CHANNEL = 'macosTccPrompts:threshold'

export type TccPromptNoticePayload = {
  promptCount: number
}

export type TccPromptNoticeClaim = TccPromptNoticePayload & {
  claimId: number
}

type TccPromptTally = {
  promptCount: number
  notified: boolean
  dismissed: boolean
}

const EMPTY_TALLY: TccPromptTally = { promptCount: 0, notified: false, dismissed: false }

let tally: TccPromptTally = { ...EMPTY_TALLY }
let mainWindowRef: BrowserWindow | null = null
let watch: MacosTccPromptWatch | null = null
let nextClaimId = 0
let pendingClaim: { claimId: number; ownerToken: number } | null = null
let deferredWatchStartTimer: ReturnType<typeof setTimeout> | null = null
let deferredWatchStartGeneration = 0

function tallyPath(): string {
  return join(getCanonicalUserDataPath(), 'macos-tcc-prompt-tally.json')
}

function loadTally(): TccPromptTally {
  try {
    const parsed = JSON.parse(readFileSync(tallyPath(), 'utf-8')) as Partial<TccPromptTally>
    return {
      promptCount: typeof parsed.promptCount === 'number' ? parsed.promptCount : 0,
      notified: parsed.notified === true,
      dismissed: parsed.dismissed === true
    }
  } catch {
    return { ...EMPTY_TALLY }
  }
}

function saveTally(): void {
  try {
    writeFileAtomically(tallyPath(), `${JSON.stringify(tally, null, 2)}\n`)
  } catch {
    // Best-effort: losing the count only means the notice arrives a launch later.
  }
}

export function handleTccPromptForTests(): TccPromptNoticePayload | null {
  return recordPrompt()
}

function recordPrompt(): TccPromptNoticePayload | null {
  if (tally.dismissed || tally.notified || tally.promptCount >= TCC_PROMPT_NOTICE_THRESHOLD) {
    return null
  }
  tally = { ...tally, promptCount: tally.promptCount + 1 }
  saveTally()
  if (tally.promptCount < TCC_PROMPT_NOTICE_THRESHOLD) {
    return null
  }
  return { promptCount: tally.promptCount }
}

export function consumePendingTccPromptNotice(ownerToken: number): TccPromptNoticeClaim | null {
  if (
    pendingClaim ||
    tally.dismissed ||
    tally.notified ||
    tally.promptCount < TCC_PROMPT_NOTICE_THRESHOLD
  ) {
    return null
  }
  const claimId = ++nextClaimId
  pendingClaim = { claimId, ownerToken }
  return { claimId, promptCount: tally.promptCount }
}

export function acknowledgePendingTccPromptNotice(ownerToken: number, claimId: number): void {
  if (
    pendingClaim?.ownerToken !== ownerToken ||
    pendingClaim.claimId !== claimId ||
    tally.dismissed ||
    tally.notified
  ) {
    return
  }
  pendingClaim = null
  tally = { ...tally, notified: true }
  saveTally()
}

export function releasePendingTccPromptNotice(ownerToken: number, claimId?: number): void {
  if (
    pendingClaim?.ownerToken === ownerToken &&
    (claimId === undefined || pendingClaim.claimId === claimId)
  ) {
    pendingClaim = null
  }
}

/** Permanently stops the notice for this user; the watcher shuts down with it. */
export function dismissTccPromptNotice(): void {
  pendingClaim = null
  tally = { ...tally, dismissed: true, notified: true }
  saveTally()
  stopTccPromptNotice()
}

function trackMainWindow(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow
  mainWindow.once('closed', () => {
    if (mainWindowRef === mainWindow) {
      mainWindowRef = null
    }
  })
}

function sendTccPromptNotice(mainWindow: BrowserWindow, payload: TccPromptNoticePayload): void {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return
  }
  try {
    mainWindow.webContents.send(TCC_PROMPT_NOTICE_CHANNEL, payload)
  } catch {
    // Why: the durable renderer pull recovers a send lost during renderer teardown.
  }
}

function cancelDeferredWatchStart(): void {
  deferredWatchStartGeneration += 1
  if (deferredWatchStartTimer) {
    clearTimeout(deferredWatchStartTimer)
    deferredWatchStartTimer = null
  }
}

function startWatchAfterFirstVisibleProgress(
  mainWindow: BrowserWindow,
  targetWatch: MacosTccPromptWatch,
  deferUntilReadyToShow: boolean
): void {
  cancelDeferredWatchStart()
  if (!deferUntilReadyToShow) {
    targetWatch.start()
    return
  }
  const generation = deferredWatchStartGeneration
  const startDeferredWatch = (): void => {
    if (deferredWatchStartGeneration !== generation) {
      return
    }
    cancelDeferredWatchStart()
    const startGeneration = deferredWatchStartGeneration
    setImmediate(() => {
      if (deferredWatchStartGeneration === startGeneration && watch === targetWatch) {
        targetWatch.start()
      }
    })
  }
  mainWindow.once('ready-to-show', startDeferredWatch)
  deferredWatchStartTimer = setTimeout(startDeferredWatch, TCC_PROMPT_WATCH_START_FALLBACK_MS)
  deferredWatchStartTimer.unref?.()
}

export function initTccPromptNotice(
  mainWindow: BrowserWindow,
  options?: { deferWatchUntilReadyToShow?: boolean }
): void {
  if (process.platform !== 'darwin') {
    return
  }
  if (watch) {
    trackMainWindow(mainWindow)
    startWatchAfterFirstVisibleProgress(
      mainWindow,
      watch,
      options?.deferWatchUntilReadyToShow === true
    )
    return
  }
  tally = loadTally()
  if (tally.dismissed || tally.notified) {
    return
  }
  if (tally.promptCount >= TCC_PROMPT_NOTICE_THRESHOLD) {
    sendTccPromptNotice(mainWindow, {
      promptCount: tally.promptCount
    })
    return
  }
  trackMainWindow(mainWindow)
  watch = new MacosTccPromptWatch({
    onPrompt: () => {
      const payload = recordPrompt()
      if (!payload) {
        return
      }
      const target = mainWindowRef
      if (target) {
        sendTccPromptNotice(target, payload)
      }
      // Why: pending state is renderer-acknowledged, so the log child can stop at threshold.
      stopTccPromptNotice()
    }
  })
  startWatchAfterFirstVisibleProgress(
    mainWindow,
    watch,
    options?.deferWatchUntilReadyToShow === true
  )
}

export function stopTccPromptNotice(): void {
  cancelDeferredWatchStart()
  watch?.stop()
  watch = null
  mainWindowRef = null
}

export function resetTccPromptNoticeForTests(): void {
  cancelDeferredWatchStart()
  tally = { ...EMPTY_TALLY }
  watch = null
  mainWindowRef = null
  nextClaimId = 0
  pendingClaim = null
}
