import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { platform, arch } from 'node:os'
import type { WebContents } from 'electron'
import { BrowserError } from './cdp-bridge'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import { EMBEDDED_NAVIGATION_TIMEOUT_MS } from './agent-browser-bridge-types'
import { ensureDependencyBinaryExecutable } from './agent-browser-dependency-binary'
import { isAgentBrowserStaleRefError } from './agent-browser-batch-command'

export function agentBrowserNativeName(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return `agent-browser-${platform()}-${arch()}${ext}`
}

export function resolveAgentBrowserBinary(): string {
  // resourcesPath preserves the case-sensitive macOS Resources path.
  const bundledResourcesPath =
    process.resourcesPath ??
    (process.platform === 'darwin'
      ? join(app.getPath('exe'), '..', '..', 'Resources')
      : join(app.getPath('exe'), '..', 'resources'))
  const bundled = join(bundledResourcesPath, agentBrowserNativeName())
  if (existsSync(bundled)) {
    return bundled
  }

  // Bundling makes __dirname unreliable for locating development dependencies.
  const nmBin = join(
    app.getAppPath(),
    'node_modules',
    'agent-browser',
    'bin',
    agentBrowserNativeName()
  )
  if (existsSync(nmBin)) {
    ensureDependencyBinaryExecutable(nmBin)
    return nmBin
  }

  return 'agent-browser'
}

export function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inDouble = false
  let inSingle = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === ' ' && !inDouble && !inSingle) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) {
    args.push(current)
  }
  return args
}

export function stripAgentBrowserTargetArgs(args: string[]): string[] {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--cdp' || arg === '--session') {
      index++
      continue
    }
    if (arg.startsWith('--cdp=') || arg.startsWith('--session=')) {
      continue
    }
    stripped.push(arg)
  }
  return stripped
}

// Stale refs need a distinct code so agents can retry with a fresh snapshot.
export function classifyErrorCode(message: string): string {
  if (isAgentBrowserStaleRefError(message)) {
    return 'browser_stale_ref'
  }
  return 'browser_error'
}

export function isAbortedNavigationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const { code, errno } = error as { code?: unknown; errno?: unknown }
  return code === 'ERR_ABORTED' || errno === -3
}

export function isWebContentsLoading(wc: WebContents): boolean {
  try {
    return wc.isLoading()
  } catch {
    // The caller rechecks authoritative page registration after waiting.
    return false
  }
}

export function isLoadingMainFrame(wc: WebContents): boolean {
  try {
    return wc.isLoadingMainFrame()
  } catch {
    return false
  }
}

export function waitForAbortedNavigationReplacement(
  wc: WebContents,
  browserPageId: string,
  timeoutMs: number
): Promise<void> {
  if (!isWebContentsLoading(wc)) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (error?: BrowserError): void => {
      if (settled) {
        return
      }
      settled = true
      wc.removeListener('did-stop-loading', onDidStopLoading)
      wc.removeListener('destroyed', onDestroyed)
      if (timeout) {
        clearTimeout(timeout)
      }
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const onDidStopLoading = (): void => finish()
    const onDestroyed = (): void => finish()

    wc.on('did-stop-loading', onDidStopLoading)
    wc.on('destroyed', onDestroyed)
    timeout = setTimeout(
      () =>
        finish(
          new BrowserError(
            'browser_error',
            `Failed to navigate browser page ${browserPageId}: Browser navigation timed out after ${EMBEDDED_NAVIGATION_TIMEOUT_MS}ms`
          )
        ),
      timeoutMs
    )
    timeout.unref?.()

    // Loading may finish between loadURL rejection and listener attachment.
    if (!isWebContentsLoading(wc)) {
      finish()
    }
  })
}

export function isTabClosedTransportError(message: string): boolean {
  return /session destroyed while command|session destroyed while commands|connection refused|cdp discovery methods failed|websocket connect failed/i.test(
    message
  )
}

export function pageUnavailableMessageForSession(sessionName: string): string {
  const prefix = ORCA_TAB_SESSION_PREFIX
  const browserPageId = sessionName.startsWith(prefix) ? sessionName.slice(prefix.length) : null
  return browserPageId
    ? `Browser page ${browserPageId} is no longer available`
    : 'Browser tab is no longer available'
}
