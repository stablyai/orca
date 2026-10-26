import { randomUUID } from 'node:crypto'
import type { ComputerActionResult } from '../../shared/runtime-types'
import type { DesktopAppAgentActivity, DesktopAppAgentBlock } from '../../shared/desktop-app-types'
import { parseDesktopAppSelector, selectorNamesApp } from '../../shared/desktop-app-selector'
import { isRecord } from './desktop-app-window-list'
import { isProcessAlive } from '../daemon/daemon-process-inspection'
import { processStartIdentity } from './desktop-app-process-identity'
import { RuntimeClientError } from '../computer/runtime-client-error'
import { COMPUTER_ERROR_CODES, type ComputerAppInfo } from '../../shared/computer-use-runtime-types'

// Why no Electron import: computer RPC methods are reachable from the plain-Node
// runtime graph, so the desktop shell installs the broadcaster as a listener.
type ActivityListener = (activity: DesktopAppAgentActivity) => void
// The running apps exactly as the native provider sees them when it resolves `--app`.
export type ListRunningApps = () => Promise<ComputerAppInfo[]>
// The pid the native provider itself resolves an `--app` selector to, or null when none.
export type ResolveAppPid = (selector: string) => Promise<number | null>

let activityListener: ActivityListener | null = null
const blockedApps = new Map<number, DesktopAppAgentBlock>()
const blockIdentities = new Map<number, string>()

export function setDesktopAppActivityListener(listener: ActivityListener | null): void {
  activityListener = listener
}

export function blockDesktopAppAgent(block: DesktopAppAgentBlock): void {
  blockedApps.set(block.pid, block)
  const identity = processStartIdentity(block.pid)
  if (identity === null) {
    blockIdentities.delete(block.pid)
  } else {
    blockIdentities.set(block.pid, identity)
  }
}

export function allowDesktopAppAgent(pid: number): void {
  blockedApps.delete(pid)
  blockIdentities.delete(pid)
}

export function isDesktopAppAgentBlocked(pid: number): boolean {
  pruneExitedApps()
  return blockedApps.has(pid)
}

export function resetDesktopAppAgentControlForTest(): void {
  blockedApps.clear()
  blockIdentities.clear()
  activityListener = null
}

export function findBlockedDesktopApp(selector: string | null): DesktopAppAgentBlock | null {
  const parsed = parseDesktopAppSelector(selector)
  if (!parsed) {
    return null
  }
  pruneExitedApps()
  for (const block of blockedApps.values()) {
    if (parsed.kind === 'pid' ? block.pid === parsed.pid : selectorNamesApp(parsed.name, block)) {
      return block
    }
  }
  return null
}

/** The app this selector resolves to with the native provider's own rules (resolveApp in main.swift). */
export function resolveSelectorPid(selector: string, apps: ComputerAppInfo[]): number | null {
  const parsed = parseDesktopAppSelector(selector)
  if (!parsed || parsed.kind === 'pid') {
    return parsed?.pid ?? null
  }
  const app = apps.find((candidate) =>
    selectorNamesApp(parsed.name, { appName: candidate.name, bundleId: candidate.bundleId })
  )
  return app?.pid ?? null
}

// Why: a block names one running process. Once it exits, its pid can be handed to an unrelated
// app, which must not inherit the block, and the user has nothing left to allow again.
function pruneExitedApps(): void {
  for (const pid of blockedApps.keys()) {
    if (!isProcessAlive(pid)) {
      allowDesktopAppAgent(pid)
    }
  }
}

function pruneReusedPids(apps: ComputerAppInfo[]): void {
  for (const [pid, block] of blockedApps) {
    const identity = blockIdentities.get(pid)
    if (identity !== undefined) {
      // Why: a failed read keeps the block; only a different start time proves the pid was reused.
      const current = processStartIdentity(pid)
      if (current !== null && current !== identity) {
        allowDesktopAppAgent(pid)
      }
      continue
    }
    // Why not on Linux: the block names come from X11 WM_CLASS and listApps from AT-SPI, so
    // the same live app ("Navigator" vs "Firefox") would look like a reused pid.
    const app = process.platform === 'linux' ? undefined : apps.find((a) => a.pid === pid)
    if (app && !sameApp(block, app)) {
      allowDesktopAppAgent(pid)
    }
  }
}

function sameApp(block: DesktopAppAgentBlock, app: ComputerAppInfo): boolean {
  return block.bundleId !== null && app.bundleId
    ? block.bundleId === app.bundleId
    : block.appName === app.name
}

type BlockCheck = { blocked: DesktopAppAgentBlock | null; pinnedPid: number | null }

async function findBlockedTarget(
  selector: string | null,
  listApps: ListRunningApps,
  resolveAppPid: ResolveAppPid
): Promise<BlockCheck> {
  pruneExitedApps()
  if (!selector || blockedApps.size === 0) {
    return { blocked: null, pinnedPid: null }
  }
  const apps = await listApps()
  pruneReusedPids(apps)
  const direct = findBlockedDesktopApp(selector)
  if (direct) {
    return { blocked: direct, pinnedPid: null }
  }
  // Why: the block must hold for every spelling a provider accepts for that app ("PID:5", "5",
  // "notepad.exe", a window title substring on Windows and Linux), so the final word is the pid
  // the provider itself resolves the selector to, not how this module reads the text.
  // A provider error propagates: with a stop active, an unresolvable target fails closed.
  const pids = [resolveSelectorPid(selector, apps), await resolveAppPid(selector)]
  const pid = pids.find((candidate) => candidate !== null && blockedApps.has(candidate))
  if (pid !== undefined && pid !== null) {
    return { blocked: blockedApps.get(pid) ?? null, pinnedPid: null }
  }
  const resolved = pids[1] ?? pids[0]
  if (resolved === null) {
    throw new RuntimeClientError(
      COMPUTER_ERROR_CODES.app_not_found,
      `No running app matches "${selector}".`
    )
  }
  return { blocked: null, pinnedPid: resolved }
}

export async function runComputerActionWithActivity(
  method: string,
  params: unknown,
  run: (params: unknown) => Promise<ComputerActionResult>,
  listApps: ListRunningApps,
  resolveAppPid: ResolveAppPid
): Promise<ComputerActionResult> {
  const record = isRecord(params) ? params : {}
  const appSelector = typeof record.app === 'string' ? record.app : null
  const { blocked, pinnedPid } = await findBlockedTarget(appSelector, listApps, resolveAppPid)
  if (blocked) {
    throw new RuntimeClientError(
      COMPUTER_ERROR_CODES.desktop_app_stopped_by_user,
      `The user stopped agent control of ${blocked.appName} in Orca. Ask them to allow it again.`
    )
  }
  const activityId = randomUUID()
  const parsedSelector = parseDesktopAppSelector(appSelector)
  const startPid = parsedSelector?.kind === 'pid' ? parsedSelector.pid : null
  const base = { activityId, method, appSelector }
  emit({
    ...base,
    phase: 'start',
    pid: startPid,
    windowId: numberOrNull(record.windowId),
    point: pointFromParams(record),
    ok: null,
    at: Date.now()
  })
  // Why: while a stop is active the action runs against the exact pid that passed the check,
  // so a selector cannot resolve to a different (blocked) process between the check and the action.
  const runParams = pinnedPid === null ? params : { ...record, app: `pid:${pinnedPid}` }
  try {
    const result = await run(runParams)
    emit({
      ...base,
      phase: 'end',
      pid: result.snapshot?.app?.pid ?? startPid,
      windowId:
        result.action?.targetWindowId ??
        result.snapshot?.window?.id ??
        numberOrNull(record.windowId),
      point: result.action?.targetPoint ?? pointFromParams(record),
      ok: true,
      at: Date.now()
    })
    return result
  } catch (error) {
    emit({
      ...base,
      phase: 'end',
      pid: startPid,
      windowId: numberOrNull(record.windowId),
      point: null,
      ok: false,
      at: Date.now()
    })
    throw error
  }
}

function emit(activity: DesktopAppAgentActivity): void {
  try {
    activityListener?.(activity)
  } catch (error) {
    // Why: an indicator failure must never fail the agent's action.
    console.warn('[desktop-app] activity listener failed:', error)
  }
}

function pointFromParams(record: Record<string, unknown>): { x: number; y: number } | null {
  const x = numberOrNull(record.x) ?? numberOrNull(record.fromX)
  const y = numberOrNull(record.y) ?? numberOrNull(record.fromY)
  return x !== null && y !== null ? { x, y } : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
