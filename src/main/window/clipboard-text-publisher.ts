import { app, clipboard } from 'electron'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  assertClipboardTextWriteWithinLimitWithYield,
  CLIPBOARD_TEXT_WRITE_MAX_BYTES,
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
} from '../../shared/clipboard-text'
import { isLinuxWaylandSession } from '../../shared/linux-wayland-session'
import { writeClipboardTextAndVerify } from './clipboard-text-write-verify'
import { stageClipboardPublisher } from './clipboard-publisher-executable'
import { removeAppImageRuntimeEnv } from '../pty/appimage-terminal-env'
import { isLegacyAppImageRuntimeIdentity } from '../linux-update-package-type'

const WAYLAND_CLIPBOARD_WRITE_FAILED_ERROR = 'Wayland clipboard write failed'
const MAX_PENDING_CLIPBOARD_WRITES = 32

export type ClipboardTextWriteKind = 'terminal' | 'ordinary'

type ClipboardTextPublisherDeps = {
  isWayland: () => boolean
  helperPath: () => string | Promise<string>
  run: typeof runProcess
  clearCache: () => void
  write: (text: string, kind: ClipboardTextWriteKind) => void
  validate: (text: string) => Promise<string>
}

// Workaround for https://github.com/electron/electron/issues/54645; removal checks are in the native README.
export function createClipboardTextPublisher(
  deps: ClipboardTextPublisherDeps
): (text: unknown, kind?: ClipboardTextWriteKind) => Promise<void> {
  let pending = Promise.resolve()
  let count = 0
  let queuedCodeUnits = 0
  return (text, kind = 'terminal') => {
    if (typeof text !== 'string') {
      return Promise.reject(new Error('Clipboard text must be a string'))
    }
    if (text.length > CLIPBOARD_TEXT_WRITE_MAX_BYTES) {
      return Promise.reject(new Error(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR))
    }
    if (!deps.isWayland()) {
      return deps.validate(text).then((safeText) => deps.write(safeText, kind))
    }
    if (
      count >= MAX_PENDING_CLIPBOARD_WRITES ||
      text.length > CLIPBOARD_TEXT_WRITE_MAX_BYTES - queuedCodeUnits
    ) {
      return Promise.reject(new Error('Too many pending clipboard writes'))
    }
    count += 1
    queuedCodeUnits += text.length
    // Validate inside the queue: large copies yield and must not overwrite a later request.
    const next = pending
      .then(async () => {
        const safeText = await deps.validate(text)
        const result = await deps.run({
          program: await deps.helperPath(),
          input: safeText,
          timeoutMs: 2000,
          stdio: ['pipe', 'ignore', 'ignore']
        })
        if (result.code !== 0 || result.timedOut) {
          throw new Error(WAYLAND_CLIPBOARD_WRITE_FAILED_ERROR)
        }
        // Discard any rejected Chromium source after the helper has established the actual owner.
        deps.clearCache()
      })
      .finally(() => {
        count -= 1
        queuedCodeUnits -= text.length
      })
    pending = next.catch(() => undefined)
    return next
  }
}

let stagedPublisher: Promise<string> | undefined

function publisherPath(): string | Promise<string> {
  const source = app.isPackaged
    ? join(process.resourcesPath, 'bin', 'orca-wayland-clipboard')
    : join(
        app.getAppPath(),
        'native',
        'wayland-clipboard',
        '.build',
        process.arch,
        'orca-wayland-clipboard'
      )
  if (
    !app.isPackaged ||
    !isLegacyAppImageRuntimeIdentity({
      appImagePath: process.env.APPIMAGE,
      appDirPath: process.env.APPDIR,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath
    })
  ) {
    return source
  }
  // A detached owner must not execute pages from an AppImage mount after Orca exits.
  stagedPublisher ??= stageClipboardPublisher(source, app.getPath('userData')).catch(
    (error: unknown) => {
      stagedPublisher = undefined
      throw error
    }
  )
  return stagedPublisher
}

export const publishClipboardText = createClipboardTextPublisher({
  isWayland: () =>
    isLinuxWaylandSession({
      platform: process.platform,
      env: process.env,
      ozonePlatform:
        process.platform === 'linux' ? app.commandLine.getSwitchValue('ozone-platform') : ''
    }),
  helperPath: publisherPath,
  run: (spec) => {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value
      }
    }
    removeAppImageRuntimeEnv(env)
    return runProcess({ ...spec, env })
  },
  clearCache: () => clipboard.clear(),
  write: (text, kind) => {
    if (kind === 'terminal') {
      writeClipboardTextAndVerify(text)
    } else {
      clipboard.writeText(text)
    }
  },
  validate: assertClipboardTextWriteWithinLimitWithYield
})
