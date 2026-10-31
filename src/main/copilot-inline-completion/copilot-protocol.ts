import type { CopilotStatus, CopilotStatusKind } from '../../shared/copilot-inline-completion-types'

const COPILOT_STATUS_KINDS: readonly CopilotStatusKind[] = [
  'Normal',
  'Error',
  'Warning',
  'Inactive'
]
export function buildCopilotInitializeParams(editorVersion: string): object {
  return {
    processId: process.pid,
    rootUri: null,
    workspaceFolders: [],
    capabilities: {
      workspace: { workspaceFolders: true },
      window: { showDocument: { support: true } }
    },
    initializationOptions: {
      editorInfo: { name: 'Orca', version: editorVersion },
      editorPluginInfo: { name: 'Orca Copilot', version: editorVersion }
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** checkStatus answer; anything unrecognized reads as signed out. */
export function parseCheckStatusResult(value: unknown): { signedIn: boolean; user: string | null } {
  if (!isRecord(value)) {
    return { signedIn: false, user: null }
  }
  return {
    signedIn: value.status === 'OK' || value.status === 'MaybeOk',
    user: optionalString(value.user) ?? null
  }
}

export function parseSignInResponse(value: unknown): CopilotSignInResponse | null {
  if (!isRecord(value)) {
    return null
  }
  const { command } = value
  return {
    status: optionalString(value.status),
    user: optionalString(value.user),
    userCode: optionalString(value.userCode),
    verificationUri: optionalString(value.verificationUri),
    command:
      isRecord(command) && typeof command.command === 'string'
        ? {
            command: command.command,
            arguments: Array.isArray(command.arguments) ? command.arguments : undefined
          }
        : undefined
  }
}

export function parseCopilotStatusNotification(
  params: unknown
): Pick<CopilotStatus, 'kind' | 'message' | 'busy'> | null {
  if (!isRecord(params)) {
    return null
  }
  const raw = params
  const kind = COPILOT_STATUS_KINDS.find((candidate) => candidate === raw.kind) ?? null
  return {
    kind,
    message: typeof raw.message === 'string' ? raw.message : '',
    busy: raw.busy === true
  }
}

/** Monaco has no react language ids (.tsx shares 'typescript'), but the server
 *  keys its prompt off the didOpen languageId. */
export function toCopilotDocumentLanguageId(languageId: string, filePath: string): string {
  if (languageId === 'typescript' && /\.tsx$/i.test(filePath)) {
    return 'typescriptreact'
  }
  if (languageId === 'javascript' && /\.jsx$/i.test(filePath)) {
    return 'javascriptreact'
  }
  return languageId
}

/** Why: only the GitHub device-flow page is expected; never open file:// or other schemes a server asks for. */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

export type CopilotCommand = { command: string; arguments?: unknown[] }

export type CopilotSignInResponse = {
  status?: string
  user?: string
  userCode?: string
  verificationUri?: string
  command?: CopilotCommand
}
