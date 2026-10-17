import { ipcMain } from 'electron'
import type { SetAgentKeptRequest, SetAgentKeptResult } from '../../shared/agent-run-account'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { setAgentKept } from '../agent-accounts/agent-account-keep'
import { installedAgentKeepDeps } from '../agent-accounts/agent-account-keep-wiring'

const MAX_ID_LENGTH = 512

export function readSetAgentKeptRequest(value: unknown): SetAgentKeptRequest | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const paneKey = 'paneKey' in value ? value.paneKey : undefined
  const ptyId = 'ptyId' in value ? value.ptyId : undefined
  const kept = 'kept' in value ? value.kept : undefined
  if (
    typeof paneKey !== 'string' ||
    paneKey.length > MAX_ID_LENGTH ||
    parsePaneKey(paneKey) === null ||
    (ptyId !== undefined && (typeof ptyId !== 'string' || ptyId.length > MAX_ID_LENGTH)) ||
    typeof kept !== 'boolean'
  ) {
    return null
  }
  return { paneKey, kept, ...(ptyId !== undefined ? { ptyId } : {}) }
}

/** Keep or release a local terminal agent from the tab menu. */
export function registerAgentAccountKeepHandlers(): void {
  ipcMain.handle('agentAccounts:setKept', (_event, args: unknown): SetAgentKeptResult => {
    const request = readSetAgentKeptRequest(args)
    const deps = installedAgentKeepDeps()
    if (!request || !deps) {
      return { ok: false, reason: 'unknown-pane' }
    }
    return setAgentKept(deps, request)
  })
}
