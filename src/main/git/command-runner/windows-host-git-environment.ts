import { createAbortError } from './abort-error'
import { resolveGitCommand } from './git-command-resolution'
import type { ResolvedCommand } from './wsl-command-resolution'

let waitForWindowsHostGitEnvironment: (() => Promise<void>) | null = null

export function configureWindowsHostGitEnvironmentReadiness(
  waitUntilReady: (() => Promise<void>) | null
): void {
  waitForWindowsHostGitEnvironment = waitUntilReady
}

export async function awaitWindowsHostGitEnvironmentReady(options: {
  cwd: string
  wslDistro?: string
  signal?: AbortSignal
}): Promise<void> {
  const resolved = resolveGitCommand(['--version'], options)
  await prepareWindowsHostGitEnvironment(resolved, undefined, options.signal)
}

function refreshWindowsHostPath(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) {
    return undefined
  }
  const currentPath = process.env.Path ?? process.env.PATH
  if (currentPath === undefined) {
    return env
  }
  const next = { ...env }
  const pathKeys = Object.keys(next).filter((key) => key.toLowerCase() === 'path')
  if (pathKeys.length === 0) {
    next[process.env.Path === undefined ? 'PATH' : 'Path'] = currentPath
  } else {
    for (const key of pathKeys) {
      next[key] = currentPath
    }
  }
  return next
}

export function prepareWindowsHostGitEnvironment(
  resolved: ResolvedCommand,
  env: NodeJS.ProcessEnv | undefined,
  signal?: AbortSignal
): Promise<NodeJS.ProcessEnv | undefined> | null {
  if (
    process.platform !== 'win32' ||
    resolved.wsl !== null ||
    waitForWindowsHostGitEnvironment === null
  ) {
    return null
  }
  const ready = waitForWindowsHostGitEnvironment().then(() => refreshWindowsHostPath(env))
  if (!signal) {
    return ready
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError())
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(createAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    ready.then(
      (value) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(value)
      },
      (error) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      }
    )
  })
}
