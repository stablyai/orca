import { spawn } from 'node:child_process'
import { extname } from 'node:path'
import {
  OPEN_WITH_CHOOSER_APPLICATION_ID,
  type ShellOpenWithApplication
} from '../../shared/shell-open-types'
import { launchExternalEditor } from '../external-editor-launch'
import type { OpenWithApplicationCandidate, OpenWithLaunchSpec } from './open-with-candidate'
import { listLinuxOpenWithApplications } from './linux-open-with-applications'
import { listMacOpenWithApplications } from './macos-open-with-applications'
import {
  buildWindowsLaunchInvocation,
  listWindowsOpenWithApplications
} from './windows-open-with-applications'

export type OpenWithApplicationListing = {
  applications: ShellOpenWithApplication[]
  supportsChooserDialog: boolean
}

// Why: listings hit the registry / external discovery commands; keep results
// briefly so reopening the context menu stays instant, but expire so newly
// installed applications appear without an app restart.
const LISTING_CACHE_TTL_MS = 5 * 60_000
const listingCache = new Map<
  string,
  { expiresAt: number; candidates: OpenWithApplicationCandidate[] }
>()
const inFlightListings = new Map<string, Promise<OpenWithApplicationCandidate[]>>()
// Why: launch specs never leave the main process; the renderer only echoes an
// opaque id back, so arbitrary commands cannot be injected over IPC.
const launchSpecsByApplicationId = new Map<string, OpenWithLaunchSpec>()

export async function listOpenWithApplications(
  filePath: string,
  options: { platform?: NodeJS.Platform } = {}
): Promise<OpenWithApplicationListing> {
  const platform = options.platform ?? process.platform
  const candidates = await listCachedCandidates(filePath, platform)
  for (const candidate of candidates) {
    launchSpecsByApplicationId.set(candidate.id, candidate.launch)
  }
  return {
    applications: sortApplications(candidates).map(({ id, name, isDefault }) =>
      isDefault ? { id, name, isDefault } : { id, name }
    ),
    supportsChooserDialog: platform === 'win32'
  }
}

export async function launchOpenWithApplication(
  applicationId: string,
  filePath: string,
  options: { platform?: NodeJS.Platform } = {}
): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const launch =
    applicationId === OPEN_WITH_CHOOSER_APPLICATION_ID
      ? platform === 'win32'
        ? ({ kind: 'windows-chooser' } as const)
        : null
      : (launchSpecsByApplicationId.get(applicationId) ?? null)
  if (!launch) {
    return false
  }
  const invocation = resolveLaunchInvocation(launch, filePath)
  if (!invocation) {
    return false
  }
  try {
    await (invocation.windowsVerbatimArguments
      ? spawnDetachedVerbatim(invocation.spawnCmd, invocation.spawnArgs)
      : launchExternalEditor({
          kind: 'executable',
          // Why: windowsHide sets STARTUPINFO SW_HIDE, which Office and other
          // Win32 apps honor for their first window — the launched app must be
          // visible, so never hide here.
          hideWindowsConsole: false,
          spawnCmd: invocation.spawnCmd,
          spawnArgs: invocation.spawnArgs
        }))
    return true
  } catch {
    return false
  }
}

// Why: rundll32's OpenAs_RunDLL takes its raw command-line tail and does not
// strip quotes, so a spawn-quoted spaced path never resolves; pass it verbatim.
function spawnDetachedVerbatim(spawnCmd: string, spawnArgs: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Why: SW_HIDE from windowsHide propagates into apps launched from the
    // Open With dialog, leaving them running but invisible.
    const child = spawn(spawnCmd, spawnArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true
    })
    let settled = false
    function settle(callback: () => void): void {
      if (settled) {
        return
      }
      settled = true
      child.off('error', onError)
      child.off('spawn', onSpawn)
      callback()
    }
    function onError(error: Error): void {
      settle(() => rejectPromise(error))
    }
    function onSpawn(): void {
      child.unref()
      settle(resolvePromise)
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
}

async function listCachedCandidates(
  filePath: string,
  platform: NodeJS.Platform
): Promise<OpenWithApplicationCandidate[]> {
  // Why: every discovery backend resolves handlers by file type, so one file
  // per extension is representative and cheap to cache.
  const cacheKey = `${platform}:${extname(filePath).toLowerCase()}`
  const cached = listingCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.candidates
  }
  const inFlight = inFlightListings.get(cacheKey)
  if (inFlight) {
    return inFlight
  }
  const listing = loadCandidates(filePath, platform)
    .then((candidates) => {
      listingCache.set(cacheKey, { expiresAt: Date.now() + LISTING_CACHE_TTL_MS, candidates })
      return candidates
    })
    .catch(() => [] as OpenWithApplicationCandidate[])
    .finally(() => {
      inFlightListings.delete(cacheKey)
    })
  inFlightListings.set(cacheKey, listing)
  return listing
}

function loadCandidates(
  filePath: string,
  platform: NodeJS.Platform
): Promise<OpenWithApplicationCandidate[]> {
  if (platform === 'win32') {
    return listWindowsOpenWithApplications(filePath)
  }
  if (platform === 'darwin') {
    return listMacOpenWithApplications(filePath)
  }
  return listLinuxOpenWithApplications(filePath)
}

function resolveLaunchInvocation(
  launch: OpenWithLaunchSpec,
  filePath: string
): { spawnCmd: string; spawnArgs: string[]; windowsVerbatimArguments?: boolean } | null {
  if (launch.kind === 'windows-command') {
    return buildWindowsLaunchInvocation(launch.command, filePath)
  }
  if (launch.kind === 'windows-chooser') {
    const systemRoot = process.env.SystemRoot?.trim() || 'C:\\Windows'
    return {
      spawnCmd: `${systemRoot}\\System32\\rundll32.exe`,
      spawnArgs: [`shell32.dll,OpenAs_RunDLL ${filePath}`],
      windowsVerbatimArguments: true
    }
  }
  if (launch.kind === 'macos-application') {
    return { spawnCmd: 'open', spawnArgs: ['-a', launch.applicationPath, filePath] }
  }
  return { spawnCmd: 'gio', spawnArgs: ['launch', launch.desktopFilePath, filePath] }
}

function sortApplications(
  candidates: OpenWithApplicationCandidate[]
): OpenWithApplicationCandidate[] {
  return [...candidates].sort((a, b) => {
    if (Boolean(a.isDefault) !== Boolean(b.isDefault)) {
      return a.isDefault ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })
}
