import { taskProviderFailure } from '../../shared/work-items/task-provider-failure'
import { CredentialDecryptionError } from '../credentials/integration-credential-file'
import type {
  ClickUpConnectionStatus,
  ClickUpConnectResult,
  ClickUpViewer,
  ClickUpWorkspace
} from '../../shared/clickup/clickup-types'
import { clickupRequest } from './authenticated-request'
import { withRequestDeadline } from '../network/request-deadline'
import { ClickUpApiError, isClickUpAuthError, toClickUpDeadlineError } from './clickup-api-error'
import { mapClickUpViewer, mapClickUpWorkspaces } from './clickup-response-mapping'
import { clearScannedClickUpPages } from './clickup-task-scan-cache'
import {
  deleteToken,
  getAccountState,
  getCredentialError,
  getTokenProtection,
  inAccountOrder,
  readToken,
  saveToken,
  writeAccountState
} from './clickup-account-store'

export type ClickUpContext = {
  token: string
  viewer: ClickUpViewer | null
  workspaceId: string | null
}

// Below the renderer's 30s RPC timeout, so a multi-request operation fails here with a clear error first.
const OPERATION_DEADLINE_MS = 25_000

/** The stored credential plus the signal that bounds the operation using it. */
export type ClickUpOperationContext = ClickUpContext & { signal: AbortSignal }

type VerifiedAccount = { viewer: ClickUpViewer; workspaces: ClickUpWorkspace[] }

/** Confirms a token against the API and lists the Workspaces it can reach, both requests under one deadline. */
async function verifyToken(token: string): Promise<VerifiedAccount> {
  try {
    return await withRequestDeadline(undefined, OPERATION_DEADLINE_MS, async (signal) => {
      const viewer = mapClickUpViewer(await clickupRequest<unknown>(token, '/user', { signal }))
      if (!viewer) {
        throw new ClickUpApiError('ClickUp returned an unexpected account response.')
      }
      const workspaces = mapClickUpWorkspaces(
        await clickupRequest<unknown>(token, '/team', { signal })
      )
      // A verification that finished as the deadline fired must not lead to a save the renderer already gave up on.
      signal.throwIfAborted()
      return { viewer, workspaces }
    })
  } catch (error) {
    throw toClickUpDeadlineError(error)
  }
}

function describeVerificationFailure(error: unknown): string {
  if (error instanceof ClickUpApiError) {
    if (isClickUpAuthError(error)) {
      return 'ClickUp rejected the token. Check that it is a personal API token and has not been revoked.'
    }
    return error.message
  }
  return error instanceof Error ? error.message : 'Connection failed.'
}

function resolveSelectedWorkspaceId(
  workspaces: ClickUpWorkspace[],
  preferredId: string | null
): string | null {
  return workspaces.some((workspace) => workspace.id === preferredId)
    ? preferredId
    : (workspaces[0]?.id ?? null)
}

export async function getStatus(): Promise<ClickUpConnectionStatus> {
  const state = await getAccountState()
  const connected = state.viewer !== null
  const credentialError = connected ? await getCredentialError() : undefined
  return {
    connected,
    viewer: state.viewer,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    ...(credentialError ? { credentialError } : {}),
    credentialProtection:
      connected && (await getTokenProtection()) === 'plaintext' ? 'plaintext' : null
  }
}

/** The stored token and selection, or null when ClickUp is not connected. */
export async function getContext(): Promise<ClickUpContext | null> {
  const state = await getAccountState()
  if (!state.viewer) {
    return null
  }
  const token = await readToken()
  return token ? { token, viewer: state.viewer, workspaceId: state.selectedWorkspaceId } : null
}

export async function connect(rawToken: string): Promise<ClickUpConnectResult> {
  const token = rawToken.trim()
  if (!token) {
    return taskProviderFailure('clickup.tokenRequired', 'Personal API token is required.')
  }
  let account: VerifiedAccount
  try {
    account = await verifyToken(token)
  } catch (error) {
    return taskProviderFailure('clickup.connectionFailed', describeVerificationFailure(error))
  }
  if (account.workspaces.length === 0) {
    return taskProviderFailure('clickup.noWorkspaces', 'This ClickUp account has no Workspaces.')
  }
  await inAccountOrder(async () => {
    const previous = await getAccountState()
    await saveToken(token)
    await writeAccountState({
      version: 1,
      viewer: account.viewer,
      workspaces: account.workspaces,
      selectedWorkspaceId: resolveSelectedWorkspaceId(
        account.workspaces,
        previous.selectedWorkspaceId
      )
    })
    clearScannedClickUpPages()
  })
  return { ok: true, viewer: account.viewer }
}

export async function disconnect(): Promise<void> {
  await inAccountOrder(async () => {
    await deleteToken()
    await writeAccountState({ version: 1, viewer: null, workspaces: [], selectedWorkspaceId: null })
    clearScannedClickUpPages()
  })
}

export async function selectWorkspace(workspaceId: string): Promise<ClickUpConnectionStatus> {
  await inAccountOrder(async () => {
    const state = await getAccountState()
    if (state.workspaces.some((workspace) => workspace.id === workspaceId)) {
      await writeAccountState({ ...state, selectedWorkspaceId: workspaceId })
      clearScannedClickUpPages()
    }
  })
  return getStatus()
}

/** Revokes the stored credential after an auth failure, unless a reconnect already replaced it. */
async function clearToken(failedToken: string): Promise<void> {
  await inAccountOrder(async () => {
    let current: string | null
    try {
      current = await readToken()
    } catch (error) {
      if (error instanceof CredentialDecryptionError) {
        return
      }
      throw error
    }
    if (current !== failedToken) {
      return
    }
    await deleteToken()
    await writeAccountState({ version: 1, viewer: null, workspaces: [], selectedWorkspaceId: null })
    clearScannedClickUpPages()
  })
}

/**
 * Runs a read or write with the stored token under a deadline and the caller's cancellation;
 * a 401 that means the token is revoked clears the credential so status reports disconnected.
 */
export async function withClickUpContext<T>(
  run: (context: ClickUpOperationContext) => Promise<T>,
  { signal, write = false }: { signal?: AbortSignal; write?: boolean } = {}
): Promise<T | null> {
  const context = await getContext()
  if (!context) {
    return null
  }
  try {
    return await withRequestDeadline(signal, OPERATION_DEADLINE_MS, (deadlineSignal) =>
      run({ ...context, signal: deadlineSignal })
    )
  } catch (error) {
    if (isClickUpAuthError(error)) {
      await clearToken(context.token)
    }
    throw toClickUpDeadlineError(error, signal, write)
  }
}

/** Re-verifies the stored token and refreshes the viewer and Workspace list from the API. */
export async function testConnection(): Promise<ClickUpConnectResult> {
  let context: ClickUpContext | null
  try {
    context = await getContext()
  } catch (error) {
    return error instanceof Error
      ? { ok: false, error: error.message }
      : taskProviderFailure('clickup.connectionFailed', 'Connection failed.')
  }
  if (!context) {
    return taskProviderFailure('clickup.notConnected', 'Not connected to ClickUp.')
  }
  try {
    const account = await verifyToken(context.token)
    await inAccountOrder(async () => {
      const state = await getAccountState()
      await writeAccountState({
        version: 1,
        viewer: account.viewer,
        workspaces: account.workspaces,
        selectedWorkspaceId: resolveSelectedWorkspaceId(
          account.workspaces,
          state.selectedWorkspaceId
        )
      })
      clearScannedClickUpPages()
    })
    return { ok: true, viewer: account.viewer }
  } catch (error) {
    if (isClickUpAuthError(error)) {
      await clearToken(context.token)
    }
    return taskProviderFailure('clickup.connectionFailed', describeVerificationFailure(error))
  }
}
