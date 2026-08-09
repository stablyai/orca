import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  DebugAdapterConfig,
  DebugSession,
  DebugSessionState
} from '../../shared/debug-session-types'
import { resolveDebugAdapterProcessHost } from '../debug/debug-adapter-host-resolution'
import { DapClient, type DapEventMessage } from '../debug/dap-client'
import { DebugSessionStateMachine } from '../debug/debug-session-state-machine'
import {
  getDebugSession,
  registerDebugSession,
  unregisterDebugSession,
  updateDebugSessionState,
  type DebugSessionRuntime
} from '../debug/debug-session-registry'
import { getSshConnectionManager } from './ssh'
import type { Store } from '../persistence'

function requireDebugSession(sessionId: string): DebugSessionRuntime {
  const runtime = getDebugSession(sessionId)
  if (!runtime) {
    throw new Error(`No debug session "${sessionId}"`)
  }
  return runtime
}

export function registerDebugHandlers(mainWindow: BrowserWindow, store: Store): void {
  // Remove prior handlers so re-registration (e.g. macOS re-activate creating a new window) doesn't double-register.
  ipcMain.removeHandler('debug:start')
  ipcMain.removeHandler('debug:setBreakpoints')
  ipcMain.removeHandler('debug:continue')
  ipcMain.removeHandler('debug:pause')
  ipcMain.removeHandler('debug:stepOver')
  ipcMain.removeHandler('debug:stepInto')
  ipcMain.removeHandler('debug:stepOut')
  ipcMain.removeHandler('debug:terminate')
  ipcMain.removeHandler('debug:evaluate')
  ipcMain.removeHandler('debug:getStackTrace')
  ipcMain.removeHandler('debug:getVariables')
  ipcMain.removeHandler('debug:getThreads')

  ipcMain.handle(
    'debug:start',
    async (
      _event,
      args: { worktreeId: string; connectionId?: string | null; config: DebugAdapterConfig }
    ): Promise<string> => {
      const { host, hostId } = resolveDebugAdapterProcessHost({
        worktreeId: args.worktreeId,
        connectionId: args.connectionId,
        store,
        getSshConnection: (connectionId) => getSshConnectionManager()?.getConnection(connectionId)
      })
      const proc = await host.spawn(args.config)
      const client = new DapClient(proc.stdin, proc.stdout, proc.stderr)
      const machine = new DebugSessionStateMachine(client)
      const sessionId = randomUUID()
      const session: DebugSession = {
        id: sessionId,
        worktreeId: args.worktreeId,
        hostId,
        config: args.config,
        state: 'initializing'
      }
      registerDebugSession({ session, client, machine })

      machine.on('stateChanged', (state: DebugSessionState) => {
        updateDebugSessionState(sessionId, state)
        mainWindow.webContents.send('debug:event', { sessionId, type: 'stateChanged', state })
        if (state === 'terminated') {
          proc.kill()
          unregisterDebugSession(sessionId)
        }
      })
      machine.on('event', (msg: DapEventMessage) => {
        mainWindow.webContents.send('debug:event', { sessionId, type: 'adapterEvent', event: msg })
      })
      client.on('stderr', (text: string) => {
        mainWindow.webContents.send('debug:event', { sessionId, type: 'stderr', text })
      })

      try {
        await machine.initialize({
          adapterID: args.config.type,
          clientID: 'orca',
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: 'path'
        })
        await machine.launch({ request: args.config.request, args: args.config.adapterArgs ?? {} })
        await machine.configurationDone()
      } catch (err) {
        proc.kill()
        unregisterDebugSession(sessionId)
        throw err
      }

      return sessionId
    }
  )

  ipcMain.handle(
    'debug:setBreakpoints',
    async (_event, args: { sessionId: string; args: Record<string, unknown> }) =>
      requireDebugSession(args.sessionId).machine.setBreakpoints(args.args)
  )
  ipcMain.handle('debug:continue', async (_event, args: { sessionId: string; threadId: number }) =>
    requireDebugSession(args.sessionId).machine.continue(args.threadId)
  )
  ipcMain.handle('debug:pause', async (_event, args: { sessionId: string; threadId: number }) =>
    requireDebugSession(args.sessionId).machine.pause(args.threadId)
  )
  ipcMain.handle('debug:stepOver', async (_event, args: { sessionId: string; threadId: number }) =>
    requireDebugSession(args.sessionId).machine.stepOver(args.threadId)
  )
  ipcMain.handle('debug:stepInto', async (_event, args: { sessionId: string; threadId: number }) =>
    requireDebugSession(args.sessionId).machine.stepInto(args.threadId)
  )
  ipcMain.handle('debug:stepOut', async (_event, args: { sessionId: string; threadId: number }) =>
    requireDebugSession(args.sessionId).machine.stepOut(args.threadId)
  )
  ipcMain.handle('debug:terminate', async (_event, args: { sessionId: string }) => {
    const runtime = getDebugSession(args.sessionId)
    if (!runtime) {
      return
    }
    await runtime.machine.terminate()
  })
  ipcMain.handle(
    'debug:evaluate',
    async (_event, args: { sessionId: string; args: Record<string, unknown> }) =>
      requireDebugSession(args.sessionId).machine.evaluate(args.args)
  )
  ipcMain.handle(
    'debug:getStackTrace',
    async (_event, args: { sessionId: string; threadId: number }) =>
      requireDebugSession(args.sessionId).machine.getStackTrace(args.threadId)
  )
  ipcMain.handle(
    'debug:getVariables',
    async (_event, args: { sessionId: string; variablesReference: number }) =>
      requireDebugSession(args.sessionId).machine.getVariables(args.variablesReference)
  )
  ipcMain.handle('debug:getThreads', async (_event, args: { sessionId: string }) =>
    requireDebugSession(args.sessionId).machine.getThreads()
  )
}
