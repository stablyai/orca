import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'
import type { WslTranscriptFsReusableProcessCall } from '../native-chat/wsl-transcript-fs-process-protocol'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listeners: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  runProcess: vi.fn<(spec: { args?: string[] }) => Promise<ProcessResult>>(),
  fsCalls: new Array<string>(),
  running: false,
  home: ''
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (_event: unknown, args?: unknown) => unknown) =>
      mocks.handlers.set(channel, handler),
    on: (channel: string, listener: (_event: unknown, args?: unknown) => unknown) =>
      mocks.listeners.set(channel, listener)
  }
}))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))

const GUEST_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const ROOT = '\\\\wsl.localhost\\Ubuntu\\'
const TRANSCRIPT = `${GUEST_HOME}\\.claude\\projects\\-repo\\sess-wsl.jsonl`

// The distro's 9P share, backed by a temp dir: any touch of it starts the distro, as on Windows.
function onShare(path: string): string {
  mocks.fsCalls.push(path)
  mocks.running = true
  return path === ROOT ? mocks.home : join(mocks.home, ...path.slice(GUEST_HOME.length).split('\\'))
}

vi.mock('../native-chat/wsl-transcript-fs-process-dispatch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runWslTranscriptFsProcess: async (request: WslTranscriptFsReusableProcessCall) => {
    const path = onShare(request.path)
    switch (request.operation) {
      case 'access':
        await access(path)
        return true
      case 'stat':
        return stat(path)
      case 'lstat':
        return lstat(path)
      case 'readdir':
        return readdir(path, { withFileTypes: true })
      case 'readfile':
        return readFile(path, request.encoding)
    }
  },
  openWslTranscriptFsProcess: async (path: string) => open(onShare(path), 'r')
}))

import { _resetWslCachesForTests } from '../wsl'
import { _resetWslBackgroundDistroGateForTests } from '../wsl-background-distro-gate'
import { resetWslTranscriptFsGateForTests } from '../native-chat/wsl-transcript-fs-gate'
import { readNativeChatTranscriptTail } from '../native-chat/transcript-watch'
import {
  clearNativeChatSubscriptions,
  clearNativeChatTranscriptCache,
  registerNativeChatHandlers
} from './native-chat'

let originalPlatform: NodeJS.Platform

beforeEach(async () => {
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  mocks.home = await mkdtemp(join(tmpdir(), 'orca-wsl-open-wake-'))
  const dir = join(mocks.home, '.claude', 'projects', '-repo')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'sess-wsl.jsonl'),
    `${JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-06-01T10:00:00.000Z',
      message: { role: 'user', content: 'Hi from WSL' }
    })}\n`
  )
  mocks.running = false
  mocks.fsCalls = []
  mocks.runProcess.mockReset().mockImplementation(async (spec) => ({
    code: 0,
    signal: null,
    stdout: spec.args?.includes('--running') && mocks.running ? 'Ubuntu\n' : '',
    stderr: '',
    timedOut: false
  }))
  clearNativeChatTranscriptCache()
  mocks.handlers.clear()
  registerNativeChatHandlers()
})

afterEach(async () => {
  clearNativeChatSubscriptions()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  _resetWslCachesForTests()
  _resetWslBackgroundDistroGateForTests()
  resetWslTranscriptFsGateForTests()
  await rm(mocks.home, { recursive: true, force: true })
})

// verify-18 review: opening a chat whose transcript is in a stopped distro is a user act.
describe('a user-opened chat on a stopped WSL distro', () => {
  it('starts the distro and shows its history', async () => {
    const result = await mocks.handlers.get('nativeChat:readSession')!(
      {},
      { agent: 'claude', sessionId: 'sess-wsl', transcriptPath: TRANSCRIPT }
    )

    expect(mocks.fsCalls[0]).toBe(ROOT)
    expect(result).toMatchObject({ messages: [expect.objectContaining({ role: 'user' })] })
  })

  it('starts the distro when a chat pane subscribes, and paints its history', async () => {
    const events = new EventEmitter()
    const send = vi.fn<(channel: string, payload: unknown) => void>()
    const sender = {
      id: 1,
      isDestroyed: () => false,
      on: (event: string, callback: () => void) => void events.on(event, callback),
      removeListener: (event: string, callback: () => void) =>
        void events.removeListener(event, callback),
      send
    }
    mocks.listeners.get('nativeChat:subscribe')!(
      { sender },
      {
        subscriptionId: 'pane-1',
        agent: 'claude',
        sessionId: 'sess-wsl',
        transcriptPath: TRANSCRIPT
      }
    )

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'nativeChat:appended',
        expect.objectContaining({
          frame: expect.objectContaining({
            type: 'snapshot',
            messages: [expect.objectContaining({ role: 'user' })]
          })
        })
      )
    )
    expect(mocks.fsCalls[0]).toBe(ROOT)
  })

  it('still refuses the same read when nobody opened the chat', async () => {
    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'sess-wsl',
      transcriptPath: TRANSCRIPT,
      limit: 20
    })

    expect(mocks.fsCalls).toEqual([])
    expect(mocks.running).toBe(false)
    expect(result).not.toHaveProperty('messages')
  })
})
