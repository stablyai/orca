import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JCODE_CHAT_EVENT_CHANNEL, JCODE_CHAT_SEND_CHANNEL } from '../../shared/jcode-chat-types'
import {
  cleanupTempFiles,
  makeChildProcess,
  makeMainWindow,
  makeSshConnection,
  makeTempFile,
  payload,
  VALID_REMOTE_ATTACHMENT_DIR,
  waitUntil,
  type MockSshConnection
} from './jcode-attachments.test-fixtures'

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

function setSshConnection(connection: MockSshConnection): void {
  getSshConnectionManagerMock.mockReturnValue({
    getConnection: vi.fn(() => connection)
  })
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
  cleanupTempFiles()
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

  it('treats remote temp directory creation failure as an attachment copy failure', async () => {
    const filePath = makeTempFile('note.txt', 'attachment contents')
    const connection = makeSshConnection({
      commandExitCode: (command) => (command.startsWith('umask 077 && mkdir -- ') ? 1 : 0)
    })
    setSshConnection(connection)

    const result = await resolveTurnPrompt(
      payload({ attachments: [{ kind: 'file', path: filePath, name: 'note.txt' }] }),
      { host: 'remote-host', connectionId: 'conn-1', remotePath: '/remote/project' }
    )

    expect(result.cleanup).toBeNull()
    expect(connection.writeFile).not.toHaveBeenCalled()
    expect(result.prompt).toContain('could NOT be copied to the remote host')
    expect(result.prompt).toContain(filePath)
  })

  it('does not report a copied attachment when remote base64 decode fails', async () => {
    const filePath = makeTempFile('note.txt', 'attachment contents')
    const connection = makeSshConnection({
      commandExitCode: (command) => (command.includes('base64 -d') ? 1 : 0)
    })
    setSshConnection(connection)

    const result = await resolveTurnPrompt(
      payload({ attachments: [{ kind: 'file', path: filePath, name: 'note.txt' }] }),
      { host: 'remote-host', connectionId: 'conn-1', remotePath: '/remote/project' }
    )

    expect(result.cleanup?.remoteDir).toMatch(/^\/tmp\/orca-jcode-attachments-[0-9a-f-]{36}$/)
    expect(result.prompt).toContain('could NOT be copied to the remote host')
    expect(result.prompt).toContain(filePath)
    expect(result.prompt).not.toContain(`${result.cleanup?.remoteDir}/note.txt`)
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
  it('keeps remote-exec image attachments local via --image', async () => {
    const filePath = makeTempFile('photo.png', 'image bytes')
    const connection = makeSshConnection()
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
      payload({ attachments: [{ kind: 'file', path: filePath, name: 'photo.png' }] })
    )

    await waitUntil(() => spawnMock.mock.calls.length === 1, 'jcode was not spawned')

    const args = spawnMock.mock.calls[0]?.[1] as string[]
    expect(args).toContain('--image')
    expect(args).toContain(filePath)
    expect(connection.writeFile).not.toHaveBeenCalled()
    expect(connection.exec).not.toHaveBeenCalled()
  })

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

  it('cleans remote uploads when child spawn throws', async () => {
    const filePath = makeTempFile('turn.txt', 'remote turn')
    const connection = makeSshConnection()
    const mainWindow = makeMainWindow()
    setSshConnection(connection)
    spawnMock.mockImplementation(() => {
      throw new Error('spawn failed')
    })
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

    await waitUntil(
      () => connection.exec.mock.calls.some(([command]) => command.startsWith('rm -rf -- ')),
      'cleanup command was not attempted'
    )

    const eventTypes = mainWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === JCODE_CHAT_EVENT_CHANNEL)
      .map(([, message]) => (message as { event: { type: string } }).event.type)
    expect(eventTypes).toEqual(['error'])
  })
})
