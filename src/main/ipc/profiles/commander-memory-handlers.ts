import { agentRecovery } from '../../commander/commander-recovery-service'
import { desktopPhoneSharing } from '../../commander/commander-phone-access'
import { mkdtemp, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  commanderAccount,
  commanderAgentGrantRequest
} from '../../../shared/commander/memory-contract'
import { restrictStagedWindowsPath } from '../../../shared/secure-storage/secure-path-windows-acl'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  commanderMemoryService,
  recurringAnswersSetting,
  mintCommanderAgentGrant
} from '../../commander/commander-memory-service'
import { isTrustedUIRenderer } from '../ui'

function requirePrimaryWindow(event: IpcMainInvokeEvent): void {
  if (
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedUIRenderer(event.sender)
  ) {
    throw new Error('Commander memory access requires the main Orca window.')
  }
}

export function registerCommanderMemoryHandlers(): void {
  ipcMain.handle('commanderMemory:recurringAnswers', (event, account, change) => {
    requirePrimaryWindow(event)
    return recurringAnswersSetting(account, change)
  })
  ipcMain.handle('commanderMemory:agentRecovery', (event, account, enabled) => {
    requirePrimaryWindow(event)
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new Error('Expected a boolean recovery preference.')
    }
    return agentRecovery(commanderAccount.parse(account), enabled)
  })
  ipcMain.handle('commanderMemory:phoneSharing', (event, account, enabled) => {
    requirePrimaryWindow(event)
    return desktopPhoneSharing(account, enabled)
  })
  ipcMain.handle('commanderMemory:exportAgentGrant', async (event, account, raw) => {
    requirePrimaryWindow(event)
    const grant = commanderAgentGrantRequest.parse(raw)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      throw new Error('Commander memory access requires the main Orca window.')
    }
    const selected = await dialog.showSaveDialog(window, {
      title: `Save ${grant.type ?? 'agent'} memory grant for ${grant.agentId} in ${grant.projectId}`,
      defaultPath: 'commander-agent-grant.json',
      filters: [{ name: 'Commander agent grant', extensions: ['json'] }]
    })
    if (selected.canceled || !selected.filePath) {
      return { saved: false }
    }
    const { grant: credential, assertCurrent } = await mintCommanderAgentGrant(account, grant)
    const staging = await mkdtemp(join(dirname(selected.filePath), '.orca-grant-'))
    try {
      const path = join(staging, 'credential')
      if (process.platform === 'win32' && !(await restrictStagedWindowsPath(staging, true))) {
        throw new Error('This destination cannot store an owner-only credential.')
      }
      const handle = await open(path, 'wx', 0o600)
      try {
        const privateFile =
          process.platform === 'win32'
            ? await restrictStagedWindowsPath(path, false)
            : ((await handle.stat()).mode & 0o077) === 0
        if (!privateFile) {
          throw new Error('This destination cannot store an owner-only credential.')
        }
        assertCurrent()
        await handle.writeFile(JSON.stringify(credential), 'utf8')
      } finally {
        await handle.close()
      }
      requirePrimaryWindow(event)
      assertCurrent()
      await rename(path, selected.filePath)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    return { saved: true, expiresAt: credential.expiresAt }
  })
  ipcMain.handle('commanderMemory:list', (event, account) => {
    requirePrimaryWindow(event)
    return commanderMemoryService.list(account)
  })
  ipcMain.handle('commanderMemory:index', (event, account, query) => {
    requirePrimaryWindow(event)
    return commanderMemoryService.index(account, query)
  })
  ipcMain.handle('commanderMemory:workerGuidance', (event, account, projectId) => {
    requirePrimaryWindow(event)
    return commanderMemoryService.workerGuidance(account, projectId)
  })
  ipcMain.handle('commanderMemory:get', (event, account, pageId, beforeVersion) => {
    requirePrimaryWindow(event)
    return commanderMemoryService.get(account, pageId, beforeVersion)
  })
  ipcMain.handle('commanderMemory:save', (event, account, write) => {
    requirePrimaryWindow(event)
    return commanderMemoryService.save(account, write)
  })
  ipcMain.handle('commanderMemory:checkpoint', (event, account, write) => {
    requirePrimaryWindow(event)
    return commanderMemoryService.checkpoint(account, write)
  })
}
