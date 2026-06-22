import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JCODE_CHAT_EVENT_CHANNEL,
  JCODE_CHAT_SEND_CHANNEL,
  type JcodeChatSendPayload
} from '../../shared/jcode-chat-types'

const {
  applySkillInjectionMock,
  deleteConversationMock,
  getSshConnectionManagerMock,
  ipcHandleMock,
  ipcListeners,
  ipcOnMock,
  ipcRemoveAllListenersMock,
  ipcRemoveHandlerMock,
  listConversationsMock,
  loadConversationMock,
  registerJcodeSkillsHandlerMock,
  resolveJcodeBinMock,
  resolveRemoteExecMock,
  saveConversationMock,
  spawnMock
} = vi.hoisted(() => ({
  applySkillInjectionMock: vi.fn(),
  deleteConversationMock: vi.fn(),
  getSshConnectionManagerMock: vi.fn(),
  ipcHandleMock: vi.fn(),
  ipcListeners: new Map<string, (event: unknown, raw: unknown) => void>(),
  ipcOnMock: vi.fn(),
  ipcRemoveAllListenersMock: vi.fn(),
  ipcRemoveHandlerMock: vi.fn(),
  listConversationsMock: vi.fn(),
  loadConversationMock: vi.fn(),
  registerJcodeSkillsHandlerMock: vi.fn(),
  resolveJcodeBinMock: vi.fn(),
  resolveRemoteExecMock: vi.fn(),
  saveConversationMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: ipcHandleMock,
    on: ipcOnMock,
    removeAllListeners: ipcRemoveAllListenersMock,
    removeHandler: ipcRemoveHandlerMock
  }
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

vi.mock('../ipc/ssh', () => ({
  getSshConnectionManager: getSshConnectionManagerMock
}))

vi.mock('./jcode-binary', () => ({
  resolveJcodeBin: resolveJcodeBinMock
}))

vi.mock('./jcode-conversation-store', () => ({
  deleteConversation: deleteConversationMock,
  listConversations: listConversationsMock,
  loadConversation: loadConversationMock,
  saveConversation: saveConversationMock
}))

vi.mock('./jcode-remote-exec', () => ({
  resolveRemoteExec: resolveRemoteExecMock
}))

vi.mock('./jcode-skills', () => ({
  applySkillInjection: applySkillInjectionMock,
  registerJcodeSkillsHandler: registerJcodeSkillsHandlerMock
}))

import { cleanupRemoteAttachmentDir, resolveTurnPrompt } from './jcode-attachments'
import { registerJcodeChatHandlers } from './jcode-chat-session'

type MockChannel = EventEmitter & { stderr: EventEmitter }
const VALID_REMOTE_ATTACHMENT_DIR =
  '/tmp/orca-jcode-attachments-00000000-0000-4000-8000-000000000000'

function autoClosingChannel(): MockChannel {
  const channel = new EventEmitter() as MockChannel
  channel.stderr = new EventEmitter()
  setTimeout(() => channel.emit('close'), 0)
  return channel
}

function makeSshConnection(options: { status?: string; failCleanup?: boolean } = {}) {
  const status = options.status ?? 'connected'
  return {
    exec: vi.fn((command: string) => {
      if (options.failCleanup && command.startsWith('rm -rf -- ')) {
        return Promise.reject(new Error('cleanup failed'))
      }
      return Promise.resolve(autoClosingChannel())
    }),
    getState: vi.fn(() => ({ status })),
    writeFile: vi.fn(() => Promise.resolve())
  }
}

function setSshConnection(connection: ReturnType<typeof makeSshConnection>): void {
  getSshConnectionManagerMock.mockReturnValue({
    getConnection: vi.fn(() => connection)
  })
}

const tempDirs: string[] = []

function makeTempFile(name: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-jcode-attachments-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, name)
  writeFileSync(filePath, contents)
  return filePath
}

function payload(extra: Partial<JcodeChatSendPayload> = {}): JcodeChatSendPayload {
  return { sessionKey: 'session-1', prompt: 'hello', ...extra }
}

function makeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean
    kill: ReturnType<typeof vi.fn>
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  }
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
    return true
  })
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  return child
}

function makeMainWindow() {
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

async function waitUntil(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(message)
}

beforeEach(() => {
  vi.resetAllMocks()
  ipcListeners.clear()
  ipcOnMock.mockImplementation(
    (channel: string, handler: (event: unknown, raw: unknown) => void) => {
      ipcListeners.set(channel, handler)
    }
  )
  ipcRemoveAllListenersMock.mockImplementation((channel: string) => {
    ipcListeners.delete(channel)
  })
  resolveJcodeBinMock.mockReturnValue('/usr/local/bin/jcode')
  resolveRemoteExecMock.mockReturnValue({ host: null, connectionId: null, remotePath: null })
  applySkillInjectionMock.mockImplementation((_skillName: string | undefined, promptText: string) =>
    Promise.resolve(promptText)
  )
  getSshConnectionManagerMock.mockReturnValue({ getConnection: vi.fn(() => undefined) })
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveTurnPrompt cleanup metadata', () => {
  it('returns no cleanup target for a local turn with no attachments', async () => {
    await expect(
      resolveTurnPrompt(payload(), { host: null, connectionId: null, remotePath: null })
    ).resolves.toEqual({ prompt: 'hello', cleanup: null })
  })

  it('returns the remote cleanup target when an attachment is copied', async () => {
    const filePath = makeTempFile('note.txt', 'attachment contents')
    const connection = makeSshConnection()
    setSshConnection(connection)

    const result = await resolveTurnPrompt(
      payload({ attachments: [{ kind: 'file', path: filePath, name: 'note.txt' }] }),
      { host: 'remote-host', connectionId: 'conn-1', remotePath: '/remote/project' }
    )

    expect(result.cleanup?.connectionId).toBe('conn-1')
    expect(result.cleanup?.remoteDir).toMatch(/^\/tmp\/orca-jcode-attachments-[0-9a-f-]{36}$/)
    expect(result.prompt).toContain(`${result.cleanup?.remoteDir}/note.txt`)
    expect(connection.writeFile).toHaveBeenCalledWith(
      `${result.cleanup?.remoteDir}/note.txt.b64`,
      Buffer.from('attachment contents').toString('base64')
    )
    expect(connection.exec).toHaveBeenCalledWith(expect.stringMatching(/^umask 077 && mkdir -- '/))
    expect(connection.exec).not.toHaveBeenCalledWith(expect.stringContaining('mkdir -p'))
  })
})

describe('cleanupRemoteAttachmentDir', () => {
  it('no-ops when the SSH connection is disconnected', async () => {
    const connection = makeSshConnection({ status: 'disconnected' })
    setSshConnection(connection)

    await cleanupRemoteAttachmentDir('conn-1', VALID_REMOTE_ATTACHMENT_DIR)

    expect(connection.exec).not.toHaveBeenCalled()
  })

  it('rejects unsafe directories outside the attachment root', async () => {
    const connection = makeSshConnection()
    setSshConnection(connection)

    await cleanupRemoteAttachmentDir('conn-1', '/tmp/orca-other/stale')
    await cleanupRemoteAttachmentDir('conn-1', '/tmp/orca-jcode-attachments/../outside')
    await cleanupRemoteAttachmentDir('conn-1', '/tmp/orca-jcode-attachments/stale')
    await cleanupRemoteAttachmentDir('conn-1', `${VALID_REMOTE_ATTACHMENT_DIR}/child`)

    expect(connection.exec).not.toHaveBeenCalled()
  })

  it('shell-quotes the remote attachment directory', async () => {
    const connection = makeSshConnection()
    setSshConnection(connection)

    await cleanupRemoteAttachmentDir('conn-1', VALID_REMOTE_ATTACHMENT_DIR)

    expect(connection.exec).toHaveBeenCalledWith(`rm -rf -- '${VALID_REMOTE_ATTACHMENT_DIR}'`)
  })
})

describe('jcode chat session attachment cleanup', () => {
  it('cleans remote uploads after child close without surfacing cleanup failure', async () => {
    const filePath = makeTempFile('turn.txt', 'remote turn')
    const connection = makeSshConnection({ failCleanup: true })
    const child = makeChildProcess()
    const mainWindow = makeMainWindow()
    setSshConnection(connection)
    spawnMock.mockReturnValue(child)
    resolveRemoteExecMock.mockReturnValue({
      host: 'remote-host',
      connectionId: 'conn-1',
      remotePath: '/remote/project'
    })

    registerJcodeChatHandlers(mainWindow as never)
    const sendHandler = ipcListeners.get(JCODE_CHAT_SEND_CHANNEL)
    if (!sendHandler) {
      throw new Error('send handler was not registered')
    }
    sendHandler(
      { sender: mainWindow.webContents },
      payload({ attachments: [{ kind: 'file', path: filePath, name: 'turn.txt' }] })
    )

    await waitUntil(() => spawnMock.mock.calls.length === 1, 'jcode was not spawned')
    child.emit('close', 0)
    await waitUntil(
      () => connection.exec.mock.calls.some(([command]) => command.startsWith('rm -rf -- ')),
      'cleanup command was not attempted'
    )

    const eventTypes = mainWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === JCODE_CHAT_EVENT_CHANNEL)
      .map(([, message]) => (message as { event: { type: string } }).event.type)
    expect(eventTypes).toEqual(['exit'])
  })
})
