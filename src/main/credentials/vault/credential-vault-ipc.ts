import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import {
  botToolVaultChangeSchema,
  vaultDraftSchema,
  vaultEntrySchema,
  vaultIdSchema,
  vaultValueSchema
} from '../../../shared/rpc-contract/host-management/credential-vault-params'
import type {
  ServerVaultTarget,
  VaultResult
} from '../../../shared/secure-storage/credential-vault'
import { confirmBrowserPasswordOwner } from '../../browser-passwords/browser-password-reauth'
import { getTrustedUIRendererWebContents } from '../../ipc/ui'
import { clearSecretFromClipboard } from '../../window/clipboard/clipboard-secret-clear'
import { publishClipboardText } from '../../window/clipboard/clipboard-text-publisher'
import { CredentialVault } from './credential-vault'
import { callServerVault, serverVaultTargetSchema } from './server-vault-client'

const summaries = z.array(vaultEntrySchema)

function isTrusted(event: IpcMainInvokeEvent): boolean {
  return (
    event.sender === getTrustedUIRendererWebContents() &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame
  )
}

function handle<T>(
  channel: string,
  run: (
    raw: unknown,
    event: IpcMainInvokeEvent,
    target?: ServerVaultTarget
  ) => VaultResult<T> | Promise<VaultResult<T>>
): void {
  ipcMain.handle(channel, (event, raw: unknown, rawTarget: unknown) => {
    if (!isTrusted(event)) {
      return { ok: false, reason: 'unavailable' }
    }
    const target = serverVaultTargetSchema.optional().safeParse(rawTarget)
    return target.success ? run(raw, event, target.data) : { ok: false, reason: 'invalid' }
  })
}

export function registerCredentialVaultHandlers(profileDirectory: string): void {
  const vault = new CredentialVault(join(profileDirectory, 'credential-vault', 'entries.enc'))
  handle('credentialVault:list', (_raw, _event, target) =>
    target ? callServerVault(target, { op: 'list' }, summaries) : vault.list()
  )
  handle('credentialVault:save', (raw, _event, target) => {
    const draft = vaultDraftSchema.safeParse(raw)
    if (!draft.success) {
      return { ok: false, reason: 'invalid' }
    }
    return target
      ? callServerVault(target, { op: 'save', draft: draft.data }, summaries)
      : vault.save(draft.data)
  })
  handle('credentialVault:remove', (raw, _event, target) => {
    const id = vaultIdSchema.safeParse(raw)
    if (!id.success) {
      return { ok: false, reason: 'invalid' }
    }
    return target
      ? callServerVault(target, { op: 'remove', id: id.data }, summaries)
      : vault.remove(id.data)
  })
  handle<true>('credentialVault:changeBotTool', async (raw, event, target) => {
    const change = botToolVaultChangeSchema.safeParse(raw)
    if (!target || !change.success) {
      return { ok: false, reason: 'invalid' }
    }
    if (
      change.data.binding &&
      !(await confirmBrowserPasswordOwner('let a bot use a vault credential', { always: true }))
    ) {
      return { ok: false, reason: 'auth-failed' }
    }
    return isTrusted(event)
      ? callServerVault(target, { op: 'bot-tool', change: change.data }, z.literal(true))
      : { ok: false, reason: 'unavailable' }
  })
  handle<true>('credentialVault:copy', async (raw, event, target) => {
    const id = vaultIdSchema.safeParse(raw)
    if (!id.success) {
      return { ok: false, reason: 'invalid' }
    }
    try {
      if (!(await confirmBrowserPasswordOwner('copy a vault credential', { always: true }))) {
        return { ok: false, reason: 'auth-failed' }
      }
      if (!isTrusted(event)) {
        return { ok: false, reason: 'unavailable' }
      }
      const result = target
        ? await callServerVault(target, { op: 'read', id: id.data }, vaultValueSchema)
        : vault.readValue(id.data)
      if (!result.ok) {
        return result
      }
      if (!isTrusted(event)) {
        return { ok: false, reason: 'unavailable' }
      }
      await publishClipboardText(result.value, 'ordinary')
      clearSecretFromClipboard(result.value)
      return { ok: true, value: true }
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
  })
}
