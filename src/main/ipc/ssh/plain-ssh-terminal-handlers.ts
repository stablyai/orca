/** IPC for plain SSH terminals; the renderer names a saved target id and never any argv. */
import { homedir } from 'node:os'
import { ipcMain, type WebContents } from 'electron'
import {
  PLAIN_SSH_TERMINAL_CHANNELS,
  type PlainSshTerminalEvent
} from '../../../shared/terminal/runtime/plain-ssh-terminal'
import type { PlainSshTerminalDeps } from '../../ssh/plain-ssh-terminal/plain-ssh-terminal-sessions'
import type * as PlainSshTerminalSessions from '../../ssh/plain-ssh-terminal/plain-ssh-terminal-sessions'

type PlainSshTerminalRuntime = {
  sessions: typeof PlainSshTerminalSessions
  deps: PlainSshTerminalDeps
}

let loadedRuntime: PlainSshTerminalRuntime | null = null
let runtimeLoadPromise: Promise<PlainSshTerminalRuntime> | null = null

function loadPlainSshTerminalRuntime(): Promise<PlainSshTerminalRuntime> {
  if (loadedRuntime) {
    return Promise.resolve(loadedRuntime)
  }
  runtimeLoadPromise ??= Promise.all([
    import('../../ssh/plain-ssh-terminal/plain-ssh-terminal-sessions'),
    import('../../../shared/remote-runtime/ssh/ssh-host-move-blocked'),
    import('../../ssh/config/ssh-config-alias-claim'),
    import('../../ssh/host-server/ssh-host-server-status'),
    import('../../ssh/targets/ssh-target-registry'),
    import('../../ssh/system-transport/system-ssh-binary'),
    import('../../providers/local-pty/local-pty-executable-spawn')
  ])
    .then(
      ([
        sessions,
        { isSshHostMoveBlocked },
        { mayUserSshConfigClaimAlias },
        { getSshHostServerStatus },
        { getSshTargetRegistryStore },
        { findSystemSsh },
        { ensureNodePtySpawnHelperExecutable }
      ]) => {
        const deps: PlainSshTerminalDeps = {
          getTarget: (targetId) => getSshTargetRegistryStore()?.getTarget(targetId),
          isMoveBlocked: (targetId) => isSshHostMoveBlocked(getSshHostServerStatus(targetId)),
          findSsh: findSystemSsh,
          mayConfigClaimAlias: mayUserSshConfigClaimAlias,
          loadPtySpawn: async () => {
            // Packaged macOS updates can lose the node-pty spawn-helper executable bit.
            ensureNodePtySpawnHelperExecutable()
            return (await import('node-pty')).spawn
          },
          homeDir: homedir,
          platform: process.platform
        }
        loadedRuntime = { sessions, deps }
        return loadedRuntime
      }
    )
    .catch((error: unknown) => {
      runtimeLoadPromise = null
      throw error
    })
  return runtimeLoadPromise
}

const watchedOwners = new Set<number>()

/** Plain SSH sessions cannot reattach after owner reload, crash or close. */
function endSessionsWithOwner(sender: WebContents): void {
  if (watchedOwners.has(sender.id)) {
    return
  }
  watchedOwners.add(sender.id)
  const owner = sender.id
  const end = (): void => {
    loadedRuntime?.sessions.closePlainSshTerminalsOwnedBy(owner)
  }
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

export function registerPlainSshTerminalHandlers(
  handle: typeof ipcMain.handle = ipcMain.handle.bind(ipcMain)
): void {
  const { open, write, resize, close, ack, event } = PLAIN_SSH_TERMINAL_CHANNELS
  ipcMain.removeHandler(open)
  ipcMain.removeAllListeners(write)
  ipcMain.removeAllListeners(resize)
  ipcMain.removeAllListeners(close)
  ipcMain.removeAllListeners(ack)

  handle(open, async (ipcEvent, args: { targetId?: unknown; cols?: unknown; rows?: unknown }) => {
    const sender = ipcEvent.sender
    const { sessions, deps } = await loadPlainSshTerminalRuntime()
    if (sender.isDestroyed()) {
      return null
    }
    endSessionsWithOwner(sender)
    return sessions.openPlainSshTerminal(
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
  })
  ipcMain.on(write, (ipcEvent, args: { sessionId?: unknown; data?: unknown }) => {
    loadedRuntime?.sessions.writePlainSshTerminal(args?.sessionId, ipcEvent.sender.id, args?.data)
  })
  ipcMain.on(resize, (ipcEvent, args: { sessionId?: unknown; cols?: unknown; rows?: unknown }) => {
    loadedRuntime?.sessions.resizePlainSshTerminal(
      args?.sessionId,
      ipcEvent.sender.id,
      args?.cols,
      args?.rows
    )
  })
  ipcMain.on(close, (ipcEvent, args: { sessionId?: unknown }) => {
    loadedRuntime?.sessions.closePlainSshTerminal(args?.sessionId, ipcEvent.sender.id)
  })
  ipcMain.on(ack, (ipcEvent, args: { sessionId?: unknown; chars?: unknown }) => {
    loadedRuntime?.sessions.ackPlainSshTerminal(args?.sessionId, ipcEvent.sender.id, args?.chars)
  })
}
