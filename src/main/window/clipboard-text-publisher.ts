import { app, clipboard } from 'electron'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  assertClipboardTextWriteWithinLimitWithYield,
  CLIPBOARD_TEXT_WRITE_MAX_BYTES,
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
} from '../../shared/clipboard-text'
import { CLIPBOARD_IMAGE_MAX_BASE64_CHARS } from '../../shared/clipboard-image'
import { isLinuxWaylandSession } from '../../shared/linux-wayland-session'
import { writeClipboardTextAndVerify } from './clipboard-text-write-verify'
import { stageClipboardPublisher } from './clipboard-publisher-executable'
import { envWithoutAppImageRuntime } from '../pty/appimage-terminal-env'
import { isLegacyAppImageRuntimeIdentity } from '../linux-update-package-type'

const WAYLAND_CLIPBOARD_WRITE_FAILED_ERROR = 'Wayland clipboard write failed'
const MAX_PENDING_CLIPBOARD_WRITES = 32
const MAX_PENDING_CLIPBOARD_OPERATION_BYTES = CLIPBOARD_IMAGE_MAX_BASE64_CHARS * 2

export class ClipboardPublisherBusyError extends Error {
  constructor() {
    super('Too many pending clipboard writes')
  }
}

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
export function createClipboardPublisher(deps: ClipboardTextPublisherDeps) {
  let pending = Promise.resolve()
  let count = 0
  let queuedCodeUnits = 0
  let operationCount = 0
  let operationBytes = 0
  function enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = pending.then(operation)
    pending = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
  function publish<T>(retainedBytes: number, operation: () => T | Promise<T>): Promise<T> {
    if (
      operationCount >= MAX_PENDING_CLIPBOARD_WRITES ||
      retainedBytes > MAX_PENDING_CLIPBOARD_OPERATION_BYTES - operationBytes
    ) {
      return Promise.reject(new ClipboardPublisherBusyError())
    }
    operationCount += 1
    operationBytes += retainedBytes
    return enqueue(async () => {
      try {
        return await operation()
      } finally {
        operationCount -= 1
        operationBytes -= retainedBytes
      }
    })
  }
  function publishText(text: unknown, kind: ClipboardTextWriteKind = 'terminal'): Promise<void> {
    if (typeof text !== 'string') {
      return Promise.reject(new Error('Clipboard text must be a string'))
    }
    if (text.length > CLIPBOARD_TEXT_WRITE_MAX_BYTES) {
      return Promise.reject(new Error(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR))
    }
    const wayland = deps.isWayland()
    if (wayland) {
      if (
        count >= MAX_PENDING_CLIPBOARD_WRITES ||
        text.length > CLIPBOARD_TEXT_WRITE_MAX_BYTES - queuedCodeUnits
      ) {
        return Promise.reject(new Error('Too many pending clipboard writes'))
      }
      count += 1
      queuedCodeUnits += text.length
    }
    return enqueue(async () => {
      try {
        const safeText = await deps.validate(text)
        if (!wayland) {
          deps.write(safeText, kind)
          return
        }
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
      } finally {
        if (wayland) {
          count -= 1
          queuedCodeUnits -= text.length
        }
      }
    })
  }
  return { publish, publishText }
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

export const { publish: publishClipboardOperation, publishText: publishClipboardText } =
  createClipboardPublisher({
    isWayland: () =>
      isLinuxWaylandSession({
        platform: process.platform,
        env: process.env,
        ozonePlatform:
          process.platform === 'linux' ? app.commandLine.getSwitchValue('ozone-platform') : ''
      }),
    helperPath: publisherPath,
    run: (spec) => runProcess({ ...spec, env: envWithoutAppImageRuntime(process.env) }),
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
