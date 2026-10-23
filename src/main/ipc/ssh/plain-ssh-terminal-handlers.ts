/** IPC for plain SSH terminals; the renderer names a saved target id and never any argv. */
import { homedir } from 'node:os'
import { ipcMain, type WebContents } from 'electron'
import {
  PLAIN_SSH_TERMINAL_CHANNELS,
  type PlainSshTerminalEvent
} from '../../../shared/plain-ssh-terminal'
import { isSshHostMoveBlocked } from '../../../shared/ssh-host-move-blocked'
import { mayUserSshConfigClaimAlias } from '../../ssh/config/ssh-config-alias-claim'
import { getSshHostServerStatus } from '../../ssh/ssh-host-server-status'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { findSystemSsh } from '../../ssh/system-transport/system-ssh-binary'
import { ensureNodePtySpawnHelperExecutable } from '../../providers/local-pty-utils'
import {
  ackPlainSshTerminal,
  closePlainSshTerminal,
  closePlainSshTerminalsOwnedBy,
  openPlainSshTerminal,
  resizePlainSshTerminal,
  writePlainSshTerminal,
  type PlainSshTerminalDeps
} from '../../ssh/plain-ssh-terminal/plain-ssh-terminal-sessions'

const deps: PlainSshTerminalDeps = {
  getTarget: (targetId) => getSshTargetRegistryStore()?.getTarget(targetId),
  isMoveBlocked: (targetId) => isSshHostMoveBlocked(getSshHostServerStatus(targetId)),
  findSsh: findSystemSsh,
  mayConfigClaimAlias: mayUserSshConfigClaimAlias,
  loadPtySpawn: async () => {
    // Why: a packaged macOS build can lose node-pty's spawn-helper exec bit; the pane paths repair it too.
    ensureNodePtySpawnHelperExecutable()
    return (await import('node-pty')).spawn
  },
  homeDir: homedir,
  platform: process.platform
}

const watchedOwners = new Set<number>()

/** A reload, a crash or a closed window can't show its sessions again, so they end with it. */
function endSessionsWithOwner(sender: WebContents): void {
  if (watchedOwners.has(sender.id)) {
    return
  }
  watchedOwners.add(sender.id)
  const owner = sender.id
  const end = (): void => closePlainSshTerminalsOwnedBy(owner)
  sender.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      end()
    }
  })
  sender.on('render-process-gone', end)
  sender.once('destroyed', () => {
    watchedOwners.delete(owner)
    end()
  })
}

export function registerPlainSshTerminalHandlers(): void {
  const { open, write, resize, close, ack, event } = PLAIN_SSH_TERMINAL_CHANNELS
  ipcMain.removeHandler(open)
  ipcMain.removeAllListeners(write)
  ipcMain.removeAllListeners(resize)
  ipcMain.removeAllListeners(close)
  ipcMain.removeAllListeners(ack)

  ipcMain.handle(
    open,
    async (ipcEvent, args: { targetId?: unknown; cols?: unknown; rows?: unknown }) => {
      const sender = ipcEvent.sender
      endSessionsWithOwner(sender)
      return openPlainSshTerminal(
        deps,
        { targetId: args?.targetId, cols: args?.cols, rows: args?.rows, owner: sender.id },
        (payload: PlainSshTerminalEvent) => {
          if (sender.isDestroyed()) {
            return false
          }
          sender.send(event, payload)
          return true
        }
      )
    }
  )
  ipcMain.on(write, (ipcEvent, args: { sessionId?: unknown; data?: unknown }) => {
    writePlainSshTerminal(args?.sessionId, ipcEvent.sender.id, args?.data)
  })
  ipcMain.on(resize, (ipcEvent, args: { sessionId?: unknown; cols?: unknown; rows?: unknown }) => {
    resizePlainSshTerminal(args?.sessionId, ipcEvent.sender.id, args?.cols, args?.rows)
  })
  ipcMain.on(close, (ipcEvent, args: { sessionId?: unknown }) => {
    closePlainSshTerminal(args?.sessionId, ipcEvent.sender.id)
  })
  ipcMain.on(ack, (ipcEvent, args: { sessionId?: unknown; chars?: unknown }) => {
    ackPlainSshTerminal(args?.sessionId, ipcEvent.sender.id, args?.chars)
  })
}
