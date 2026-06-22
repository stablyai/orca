import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import type { JcodeChatSendPayload } from '../../shared/jcode-chat-types'

type MockChannel = EventEmitter & { stderr: EventEmitter }
type MockFn = ReturnType<typeof vi.fn>
type MockChildProcess = EventEmitter & {
  killed: boolean
  kill: MockFn
  stderr: EventEmitter & { setEncoding: MockFn }
  stdout: EventEmitter & { setEncoding: MockFn }
}
export type MockMainWindow = {
  isDestroyed: () => boolean
  on: MockFn
  webContents: {
    isDestroyed: () => boolean
    send: MockFn
  }
}

export const VALID_REMOTE_ATTACHMENT_DIR =
  '/tmp/orca-jcode-attachments-00000000-0000-4000-8000-000000000000'

function autoClosingChannel(exitCode = 0): MockChannel {
  const channel = new EventEmitter() as MockChannel
  channel.stderr = new EventEmitter()
  setTimeout(() => {
    channel.emit('exit', exitCode)
    channel.emit('close')
  }, 0)
  return channel
}

export function makeSshConnection(
  options: {
    status?: string
    failCleanup?: boolean
    commandExitCode?: (command: string) => number
  } = {}
) {
  const status = options.status ?? 'connected'
  return {
    exec: vi.fn((command: string) => {
      if (options.failCleanup && command.startsWith('rm -rf -- ')) {
        return Promise.reject(new Error('cleanup failed'))
      }
      return Promise.resolve(autoClosingChannel(options.commandExitCode?.(command) ?? 0))
    }),
    getState: vi.fn(() => ({ status })),
    writeFile: vi.fn(() => Promise.resolve())
  }
}

export type MockSshConnection = ReturnType<typeof makeSshConnection>

const tempDirs: string[] = []

export function makeTempFile(name: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-jcode-attachments-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, name)
  writeFileSync(filePath, contents)
  return filePath
}

export function cleanupTempFiles(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function payload(extra: Partial<JcodeChatSendPayload> = {}): JcodeChatSendPayload {
  return { sessionKey: 'session-1', prompt: 'hello', ...extra }
}

export function makeChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
    return true
  })
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  return child
}

export function makeMainWindow(): MockMainWindow {
  const webContents = {
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  }
  return {
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    webContents
  }
}

export async function waitUntil(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(message)
}
