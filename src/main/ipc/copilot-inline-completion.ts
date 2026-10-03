import { app, clipboard, ipcMain, shell, webContents } from 'electron'
import type { Store } from '../persistence'
import {
  COPILOT_MAX_DOCUMENT_CHARS,
  type CopilotChangeDocumentArgs,
  type CopilotCloseDocumentArgs,
  type CopilotInlineCompletionArgs,
  type CopilotInlineCompletionResult,
  type CopilotOpenDocumentArgs,
  type CopilotOpenDocumentResult,
  type CopilotSignInResult,
  type CopilotStatus
} from '../../shared/copilot-inline-completion-types'
import { createCopilotLanguageServer } from '../copilot-inline-completion/copilot-language-server'
import {
  createCopilotServerLocator,
  spawnCopilotServer
} from '../copilot-inline-completion/copilot-server-process'
import { resolveAuthorizedPath } from './filesystem-auth'
import { isDescendantOrEqual } from './filesystem-path-containment'

const STATUS_CHANNEL = 'copilotCompletion:status'

function broadcast(channel: string, payload: unknown): void {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) {
      contents.send(channel, payload)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function readOpenDocumentArgs(value: unknown): CopilotOpenDocumentArgs {
  if (
    !isRecord(value) ||
    typeof value.filePath !== 'string' ||
    typeof value.rootPath !== 'string' ||
    typeof value.languageId !== 'string' ||
    typeof value.text !== 'string'
  ) {
    throw new Error('Invalid Copilot document')
  }
  return {
    filePath: value.filePath,
    rootPath: value.rootPath,
    languageId: value.languageId,
    text: value.text
  }
}

function readChangeDocumentArgs(value: unknown): CopilotChangeDocumentArgs {
  if (!isRecord(value) || typeof value.fileUri !== 'string' || typeof value.text !== 'string') {
    throw new Error('Invalid Copilot document change')
  }
  return { fileUri: value.fileUri, text: value.text }
}

function readCloseDocumentArgs(value: unknown): CopilotCloseDocumentArgs {
  if (!isRecord(value) || typeof value.fileUri !== 'string') {
    throw new Error('Invalid Copilot document close')
  }
  return { fileUri: value.fileUri }
}

function readInlineCompletionArgs(value: unknown): CopilotInlineCompletionArgs {
  if (!isRecord(value) || typeof value.fileUri !== 'string') {
    throw new Error('Invalid Copilot completion request')
  }
  const { position, formattingOptions } = value
  if (
    !isRecord(position) ||
    !isFiniteNonNegativeInteger(position.line) ||
    !isFiniteNonNegativeInteger(position.character) ||
    !isRecord(formattingOptions) ||
    !isFiniteNonNegativeInteger(formattingOptions.tabSize) ||
    typeof formattingOptions.insertSpaces !== 'boolean'
  ) {
    throw new Error('Invalid Copilot completion request')
  }
  return {
    fileUri: value.fileUri,
    position: { line: position.line, character: position.character },
    trigger: value.trigger === 'explicit' ? 'explicit' : 'automatic',
    formattingOptions: {
      tabSize: formattingOptions.tabSize,
      insertSpaces: formattingOptions.insertSpaces
    }
  }
}

export function registerCopilotInlineCompletionHandlers(store: Store): void {
  const copilot = createCopilotLanguageServer({
    editorVersion: app.getVersion(),
    locateServer: createCopilotServerLocator(),
    spawnServer: spawnCopilotServer,
    openExternal: (url) => void shell.openExternal(url).catch(() => {}),
    copyToClipboard: (text) => clipboard.writeText(text),
    onStatus: (status: CopilotStatus) => broadcast(STATUS_CHANNEL, status)
  })
  app.on('will-quit', () => copilot.dispose())

  ipcMain.handle(
    'copilotCompletion:openDocument',
    async (_event, rawArgs: unknown): Promise<CopilotOpenDocumentResult> => {
      const args = readOpenDocumentArgs(rawArgs)
      if (args.text.length > COPILOT_MAX_DOCUMENT_CHARS) {
        return { fileUri: null }
      }
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      const rootPath = await resolveAuthorizedPath(args.rootPath, store)
      // Why: rootPath becomes a server workspace folder; it must actually contain
      // the opened file, not an unrelated allowed root.
      if (!isDescendantOrEqual(filePath, rootPath)) {
        throw new Error('Copilot document must be inside its workspace root')
      }
      return copilot.openDocument({ ...args, filePath, rootPath })
    }
  )

  ipcMain.handle('copilotCompletion:changeDocument', (_event, rawArgs: unknown): void => {
    const args = readChangeDocumentArgs(rawArgs)
    copilot.changeDocument(args.fileUri, args.text)
  })

  ipcMain.handle('copilotCompletion:closeDocument', (_event, rawArgs: unknown): void => {
    copilot.closeDocument(readCloseDocumentArgs(rawArgs).fileUri)
  })

  ipcMain.handle(
    'copilotCompletion:inlineCompletion',
    (_event, rawArgs: unknown): Promise<CopilotInlineCompletionResult> =>
      copilot.inlineCompletion(readInlineCompletionArgs(rawArgs))
  )

  ipcMain.handle('copilotCompletion:status', (): Promise<CopilotStatus> => copilot.getStatus())
  ipcMain.handle('copilotCompletion:signIn', (): Promise<CopilotSignInResult> => copilot.signIn())
}
