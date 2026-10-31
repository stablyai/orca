import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { CopilotStatus } from '../../shared/copilot-inline-completion-types'
import { createCopilotLanguageServer } from './copilot-language-server'
import {
  buildCopilotInitializeParams,
  parseCopilotStatusNotification,
  toCopilotDocumentLanguageId
} from './copilot-protocol'
import { createFakeCopilotServer } from './fake-copilot-server-fixture'

const SIGNED_IN = { checkStatus: { status: 'OK', user: 'octocat' } }
const SIGNED_OUT = { checkStatus: { status: 'NotSignedIn' } }

function createCopilotWithFakeServer(autoReplies: Record<string, unknown> = SIGNED_IN) {
  const fake = createFakeCopilotServer(autoReplies)
  const statuses: CopilotStatus[] = []
  const openExternal = vi.fn()
  const copyToClipboard = vi.fn()
  const spawnServer = vi.fn(() => fake.child)
  const copilot = createCopilotLanguageServer({
    editorVersion: '1.2.3',
    locateServer: () => Promise.resolve('/usr/local/bin/copilot-language-server'),
    spawnServer,
    openExternal,
    copyToClipboard,
    onStatus: (status) => statuses.push(status)
  })
  return { fake, copilot, statuses, openExternal, copyToClipboard, spawnServer }
}

const openArgs = {
  filePath: '/workspace/repo/src/app.py',
  rootPath: '/workspace/repo',
  languageId: 'python',
  text: 'def f():\n'
}
const fileUri = pathToFileURL(openArgs.filePath).toString()

describe('buildCopilotInitializeParams', () => {
  it('identifies the editor and plugin as the README requires', () => {
    expect(buildCopilotInitializeParams('1.2.3')).toMatchObject({
      initializationOptions: { editorInfo: { name: 'Orca', version: '1.2.3' } }
    })
  })
})

describe('parseCopilotStatusNotification', () => {
  it('keeps known kinds and drops unknown ones', () => {
    expect(parseCopilotStatusNotification({ kind: 'Normal', busy: true })).toEqual({
      kind: 'Normal',
      message: '',
      busy: true
    })
    expect(parseCopilotStatusNotification({ kind: 'Weird' })?.kind).toBeNull()
    expect(parseCopilotStatusNotification(null)).toBeNull()
  })
})

describe('toCopilotDocumentLanguageId', () => {
  it('maps jsx/tsx files to their react language ids', () => {
    expect(toCopilotDocumentLanguageId('typescript', '/a/App.tsx')).toBe('typescriptreact')
    expect(toCopilotDocumentLanguageId('javascript', '/a/App.jsx')).toBe('javascriptreact')
    expect(toCopilotDocumentLanguageId('typescript', '/a/app.ts')).toBe('typescript')
  })
})

describe('createCopilotLanguageServer', () => {
  it('spawns nothing until a document is opened or sign-in is requested', async () => {
    const { spawnServer, copilot } = createCopilotWithFakeServer()
    await expect(copilot.getStatus()).resolves.toMatchObject({ installed: true, user: null })
    expect(spawnServer).not.toHaveBeenCalled()
  })

  it('reports not installed and never spawns when the binary is missing', async () => {
    const spawnServer = vi.fn()
    const copilot = createCopilotLanguageServer({
      editorVersion: '1',
      locateServer: () => Promise.resolve(null),
      spawnServer,
      openExternal: vi.fn(),
      copyToClipboard: vi.fn(),
      onStatus: vi.fn()
    })
    await expect(copilot.openDocument(openArgs)).resolves.toEqual({ fileUri: null })
    await expect(copilot.signIn()).resolves.toEqual({ state: 'unavailable' })
    await expect(copilot.getStatus()).resolves.toMatchObject({ installed: false })
    expect(spawnServer).not.toHaveBeenCalled()
  })

  it('opens documents, announces the workspace root, and pushes initial configuration', async () => {
    const { fake, copilot } = createCopilotWithFakeServer()
    const opened = await copilot.openDocument(openArgs)
    expect(opened.fileUri).toBe(fileUri)
    await fake.waitFor((message) => message.method === 'workspace/didChangeConfiguration')
    const folders = await fake.waitFor((m) => m.method === 'workspace/didChangeWorkspaceFolders')
    expect(folders.params).toMatchObject({
      event: { added: [{ uri: pathToFileURL('/workspace/repo').toString(), name: 'repo' }] }
    })
    const didOpen = await fake.waitFor((message) => message.method === 'textDocument/didOpen')
    expect(didOpen.params).toMatchObject({ textDocument: { uri: fileUri, languageId: 'python' } })
  })

  it('stays inert when signed out: no documents reach the server and the process is dropped', async () => {
    const { fake, copilot, spawnServer } = createCopilotWithFakeServer(SIGNED_OUT)
    await expect(copilot.openDocument(openArgs)).resolves.toEqual({ fileUri: null })
    expect(fake.received.some((m) => m.method === 'textDocument/didOpen')).toBe(false)
    expect(fake.child.kill).toHaveBeenCalled()
    await expect(copilot.openDocument(openArgs)).resolves.toEqual({ fileUri: null })
    expect(spawnServer).toHaveBeenCalledTimes(1)
  })

  it('keeps the server and retries when checkStatus fails instead of respawning per open', async () => {
    const { fake, copilot, spawnServer } = createCopilotWithFakeServer({})
    const first = copilot.openDocument(openArgs)
    const firstCheck = await fake.waitFor((m) => m.method === 'checkStatus')
    fake.replyError(firstCheck.id, 'boom')
    await expect(first).resolves.toEqual({ fileUri: null })
    expect(fake.child.kill).not.toHaveBeenCalled()
    fake.setAutoReply('checkStatus', { status: 'OK', user: 'octocat' })
    await expect(copilot.openDocument(openArgs)).resolves.toEqual({ fileUri })
    expect(spawnServer).toHaveBeenCalledTimes(1)
  })

  it('shares one checkStatus retry between concurrent opens', async () => {
    const { fake, copilot } = createCopilotWithFakeServer({})
    const first = copilot.openDocument(openArgs)
    const startupCheck = await fake.waitFor((m) => m.method === 'checkStatus')
    fake.replyError(startupCheck.id, 'boom')
    await expect(first).resolves.toEqual({ fileUri: null })
    fake.setAutoReply('checkStatus', { status: 'OK', user: 'octocat' })
    const opens = await Promise.all([
      copilot.openDocument(openArgs),
      copilot.openDocument(openArgs)
    ])
    expect(opens).toEqual([{ fileUri }, { fileUri }])
    expect(fake.received.filter((m) => m.method === 'checkStatus')).toHaveLength(2)
  })

  it('refuses documents over the size limit', async () => {
    const { copilot, spawnServer } = createCopilotWithFakeServer()
    const result = await copilot.openDocument({ ...openArgs, text: 'x'.repeat(1_000_001) })
    expect(result.fileUri).toBeNull()
    expect(spawnServer).not.toHaveBeenCalled()
  })

  it('stamps the synced document version onto inline completion requests', async () => {
    const { fake, copilot } = createCopilotWithFakeServer()
    await copilot.openDocument(openArgs)
    copilot.changeDocument(fileUri, 'def f():\n    ')
    const pending = copilot.inlineCompletion({
      fileUri,
      position: { line: 1, character: 4 },
      trigger: 'automatic',
      formattingOptions: { tabSize: 4, insertSpaces: true }
    })
    const request = await fake.waitFor((m) => m.method === 'textDocument/inlineCompletion')
    expect(request.params).toMatchObject({
      textDocument: { uri: fileUri, version: 2 },
      context: { triggerKind: 2 }
    })
    fake.reply(request.id, { items: [{ insertText: 'pass' }] })
    await expect(pending).resolves.toEqual({
      opened: true,
      result: { items: [{ insertText: 'pass' }] }
    })
  })

  it('reports an unknown document instead of asking the server', async () => {
    const { copilot } = createCopilotWithFakeServer()
    await expect(
      copilot.inlineCompletion({
        fileUri,
        position: { line: 0, character: 0 },
        trigger: 'explicit',
        formattingOptions: { tabSize: 2, insertSpaces: true }
      })
    ).resolves.toEqual({ opened: false, result: null })
  })

  it('closes a document only after its last reference', async () => {
    const { fake, copilot } = createCopilotWithFakeServer()
    await copilot.openDocument(openArgs)
    await copilot.openDocument(openArgs)
    copilot.closeDocument(fileUri)
    expect(fake.received.some((m) => m.method === 'textDocument/didClose')).toBe(false)
    copilot.closeDocument(fileUri)
    await fake.waitFor((m) => m.method === 'textDocument/didClose')
  })

  it('forwards didChangeStatus with the signed-in user', async () => {
    const { fake, copilot, statuses } = createCopilotWithFakeServer()
    await copilot.openDocument(openArgs)
    fake.notify('didChangeStatus', { kind: 'Normal', message: '', busy: false })
    await vi.waitFor(() => {
      expect(statuses.at(-1)).toMatchObject({ kind: 'Normal', user: 'octocat', installed: true })
    })
  })

  it('copies the device code and runs the finish command on sign-in', async () => {
    const { fake, copilot, copyToClipboard } = createCopilotWithFakeServer(SIGNED_OUT)
    const pending = copilot.signIn()
    const signIn = await fake.waitFor((message) => message.method === 'signIn')
    fake.reply(signIn.id, {
      userCode: 'ABCD-EFGH',
      command: { command: 'github.copilot.finishDeviceFlow', arguments: [], title: 'Sign in' }
    })
    await expect(pending).resolves.toEqual({
      state: 'pending',
      userCode: 'ABCD-EFGH',
      verificationUri: null
    })
    expect(copyToClipboard).toHaveBeenCalledWith('ABCD-EFGH')
    const execute = await fake.waitFor((message) => message.method === 'workspace/executeCommand')
    expect(execute.params).toEqual({ command: 'github.copilot.finishDeviceFlow', arguments: [] })
  })

  it('keeps the server alive through a slow device flow and picks up the new login', async () => {
    const { fake, copilot } = createCopilotWithFakeServer(SIGNED_OUT)
    const pending = copilot.signIn()
    const signIn = await fake.waitFor((message) => message.method === 'signIn')
    fake.reply(signIn.id, {
      userCode: 'ABCD-EFGH',
      command: { command: 'github.copilot.finishDeviceFlow', arguments: [] }
    })
    await pending
    expect(fake.child.kill).not.toHaveBeenCalled()
    const execute = await fake.waitFor((message) => message.method === 'workspace/executeCommand')
    fake.setAutoReply('checkStatus', { status: 'OK', user: 'octocat' })
    fake.reply(execute.id, null)
    await vi.waitFor(() => expect(copilot.getStatus()).resolves.toMatchObject({ user: 'octocat' }))
  })

  it('reports a failed device flow on status and clears it when sign-in restarts', async () => {
    const { fake, copilot, statuses } = createCopilotWithFakeServer(SIGNED_OUT)
    const pending = copilot.signIn()
    const signIn = await fake.waitFor((message) => message.method === 'signIn')
    fake.reply(signIn.id, { userCode: 'ABCD-EFGH', command: { command: 'finish' } })
    await pending
    const execute = await fake.waitFor((message) => message.method === 'workspace/executeCommand')
    fake.replyError(execute.id, 'device flow expired')
    await vi.waitFor(() => expect(statuses.at(-1)?.signInFailed).toBe(true))
    void copilot.signIn()
    await vi.waitFor(() => expect(statuses.at(-1)?.signInFailed).toBe(false))
  })

  it('does not report a failure when the login landed despite a failed finish request', async () => {
    const { fake, copilot, statuses } = createCopilotWithFakeServer(SIGNED_OUT)
    const pending = copilot.signIn()
    const signIn = await fake.waitFor((message) => message.method === 'signIn')
    fake.reply(signIn.id, { userCode: 'ABCD-EFGH', command: { command: 'finish' } })
    await pending
    const execute = await fake.waitFor((message) => message.method === 'workspace/executeCommand')
    fake.setAutoReply('checkStatus', { status: 'OK', user: 'octocat' })
    fake.replyError(execute.id, 'timed out')
    await vi.waitFor(() => expect(statuses.at(-1)?.user).toBe('octocat'))
    expect(statuses.some((s) => s.signInFailed)).toBe(false)
  })

  it('opens only https pages requested through window/showDocument during sign-in', async () => {
    const { fake, copilot, openExternal } = createCopilotWithFakeServer(SIGNED_OUT)
    const pending = copilot.signIn()
    const signIn = await fake.waitFor((message) => message.method === 'signIn')
    fake.reply(signIn.id, { userCode: 'ABCD-EFGH', command: { command: 'finish' } })
    await pending
    fake.requestFromServer(90, 'window/showDocument', { uri: 'file:///etc/passwd', external: true })
    fake.requestFromServer(91, 'window/showDocument', {
      uri: 'https://github.com/login/device',
      external: true
    })
    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device')
    )
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('ignores window/showDocument when no sign-in is in progress', async () => {
    const { fake, copilot, openExternal } = createCopilotWithFakeServer()
    await copilot.openDocument(openArgs)
    fake.requestFromServer(92, 'window/showDocument', {
      uri: 'https://example.com',
      external: true
    })
    const reply = await fake.waitFor((m) => m.id === 92 && m.method === undefined)
    expect(reply.result).toEqual({ success: false })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('kills the server on dispose', async () => {
    const { fake, copilot } = createCopilotWithFakeServer()
    await copilot.openDocument(openArgs)
    copilot.dispose()
    expect(fake.child.kill).toHaveBeenCalled()
  })
})
