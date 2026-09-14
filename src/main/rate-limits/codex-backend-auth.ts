import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'
import type { CodexRateLimitFetchOptions } from './codex-rate-limit-fetch-options'

const BACKEND_TIMEOUT_MS = 10_000

export type CodexBackendRequest = (url: string, init: RequestInit) => Promise<Response>

type CodexAuthFile = {
  tokens?: {
    access_token?: string
    account_id?: string
  }
}

type BackendAuthReadResult =
  | { content: string; error?: never }
  | { content?: never; error: unknown }

const backendAuthReadByPath = new Map<
  string,
  SharedAuthFilesystemOperation<BackendAuthReadResult>
>()

export function createCodexBackendRequestSignal(
  callerSignal?: AbortSignal,
  timeoutMs = BACKEND_TIMEOUT_MS
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal
}

function getBackendAuthRead(
  authPath: string
): SharedAuthFilesystemOperation<BackendAuthReadResult> {
  const existing = backendAuthReadByPath.get(authPath)
  if (existing) {
    return existing
  }
  // Why: dedupe UNC reads because Node cannot cancel an in-flight read.
  const read = createAuthFilesystemOperation(authPath, () =>
    readFile(authPath, 'utf8').then(
      (content) => ({ content }),
      (error: unknown) => ({ error })
    )
  )
  backendAuthReadByPath.set(authPath, read)
  const clearRead = (): void => {
    if (backendAuthReadByPath.get(authPath) === read) {
      backendAuthReadByPath.delete(authPath)
    }
  }
  void read.result.then(clearRead, clearRead)
  return read
}

async function readBackendAuth(authPath: string, signal: AbortSignal): Promise<string> {
  const result = await getBackendAuthRead(authPath).wait(signal)
  if ('error' in result) {
    throw result.error
  }
  return result.content
}

function getCodexHomePath(codexHomePath?: string | null): string {
  return codexHomePath ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
}

export async function getCodexBackendAuthHeaders(
  options: CodexRateLimitFetchOptions | { codexHomePath?: string | null } | undefined,
  signal: AbortSignal
): Promise<Record<string, string> | null> {
  if (signal.aborted) {
    return null
  }
  const authPath = join(getCodexHomePath(options?.codexHomePath), 'auth.json')
  const auth = JSON.parse(await readBackendAuth(authPath, signal)) as CodexAuthFile
  const accessToken = auth.tokens?.access_token
  if (!accessToken) {
    return null
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop'
  }
  if (auth.tokens?.account_id) {
    headers['ChatGPT-Account-Id'] = auth.tokens.account_id
  }
  return headers
}
