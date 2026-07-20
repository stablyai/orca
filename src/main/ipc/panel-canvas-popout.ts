/**
 * Detached panel-canvas windows: a canvas of pinned observability panels can
 * pop out into its own OS window (multi-monitor dogfooding) and reattach to
 * the main window later.
 *
 * Why a dedicated slim PTY channel instead of the main pty pipeline: the
 * delivery pipeline (ACK accounting, flow control, visibility gating, wedge
 * healing) is architecturally bound to ONE renderer window — every push lands
 * on mainWindow.webContents. Popout tiles are live TUIs (btop, nvtop, watch)
 * with no scrollback restore or daemon adoption to preserve, so a direct
 * node-pty per tile, owned by the popout's webContents and reaped with it, is
 * the contained solution that cannot regress main-window terminals.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { is } from '@electron-toolkit/utils'
import { resolvePinnedTerminalPanelSshTargetId } from '../../shared/pinned-terminal-panels'
import { buildSshArgs, findSystemSsh } from '../ssh/ssh-system-fallback'
import { getSshConnectionStore } from './ssh'

type PopoutBootPayload = {
  layout: unknown
  layoutId: string | null
  title: string | null
}

const bootPayloadByWebContentsId = new Map<number, PopoutBootPayload>()
const popoutWindowIds = new Set<number>()

type PopoutPtySession = {
  proc: pty.IPty
  ownerWebContentsId: number
}

const popoutPtys = new Map<string, PopoutPtySession>()
let nextPopoutPtyId = 1

function killPopoutPtysForOwner(ownerWebContentsId: number): void {
  for (const [id, session] of popoutPtys) {
    if (session.ownerWebContentsId !== ownerWebContentsId) {
      continue
    }
    popoutPtys.delete(id)
    try {
      session.proc.kill()
    } catch {
      // Why: the process may already be gone; reaping must not throw.
    }
  }
}

function isPopoutWindow(webContentsId: number): boolean {
  return popoutWindowIds.has(webContentsId)
}

/** The window a reattach should land in: any live non-popout window. */
function findMainWindow(): BrowserWindow | null {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !isPopoutWindow(window.webContents.id)) {
      return window
    }
  }
  return null
}

function createPopoutWindow(payload: PopoutBootPayload): void {
  const popout = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 480,
    minHeight: 320,
    title: payload.title ? `Orca — ${payload.title}` : 'Orca — Panel canvas',
    // Why: unlike the main window (custom titlebar + frameless on Linux), the
    // popout keeps the native frame — free move/resize/close on every WM and
    // no drag-region plumbing for a secondary surface.
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      webviewTag: true
    }
  })
  bootPayloadByWebContentsId.set(popout.webContents.id, payload)
  popoutWindowIds.add(popout.webContents.id)
  const ownerWebContentsId = popout.webContents.id
  popout.on('closed', () => {
    bootPayloadByWebContentsId.delete(ownerWebContentsId)
    popoutWindowIds.delete(ownerWebContentsId)
    killPopoutPtysForOwner(ownerWebContentsId)
  })
  const query = { window: 'panel-canvas-popout' }
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void popout.loadURL(`${process.env.ELECTRON_RENDERER_URL}?window=panel-canvas-popout`)
  } else {
    void popout.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}

export function registerPanelCanvasPopoutHandlers(): void {
  ipcMain.handle(
    'panelCanvasPopout:open',
    (event, args: { layout: unknown; layoutId?: string | null; title?: string | null }) => {
      // Why: popouts opening popouts adds a window tree with no owner story;
      // detach is a main-window action.
      if (isPopoutWindow(event.sender.id)) {
        return false
      }
      createPopoutWindow({
        layout: args?.layout ?? null,
        layoutId: typeof args?.layoutId === 'string' ? args.layoutId : null,
        title: typeof args?.title === 'string' ? args.title : null
      })
      return true
    }
  )

  ipcMain.handle('panelCanvasPopout:getBootPayload', (event) => {
    return bootPayloadByWebContentsId.get(event.sender.id) ?? null
  })

  ipcMain.handle(
    'panelCanvasPopout:reattach',
    (event, args: { layout: unknown; layoutId?: string | null; title?: string | null }) => {
      const mainWindow = findMainWindow()
      if (mainWindow) {
        mainWindow.webContents.send('panelCanvasPopout:adopt', {
          layout: args?.layout ?? null,
          layoutId: typeof args?.layoutId === 'string' ? args.layoutId : null,
          title: typeof args?.title === 'string' ? args.title : null
        })
        mainWindow.focus()
      }
      const senderWindow = BrowserWindow.fromWebContents(event.sender)
      if (senderWindow && isPopoutWindow(event.sender.id)) {
        senderWindow.close()
      }
      return mainWindow !== null
    }
  )

  ipcMain.handle(
    'popoutPty:spawn',
    (event, args: { host?: string | null; command: string; cols?: number; rows?: number }) => {
      if (!isPopoutWindow(event.sender.id)) {
        return { ok: false as const, error: 'popout-only' }
      }
      const command = typeof args?.command === 'string' ? args.command : ''
      if (command.length === 0) {
        return { ok: false as const, error: 'empty-command' }
      }
      const cols = Number.isInteger(args?.cols) && args.cols! > 0 ? args.cols! : 80
      const rows = Number.isInteger(args?.rows) && args.rows! > 0 ? args.rows! : 24
      const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }

      let file: string
      let spawnArgs: string[]
      if (args?.host) {
        const targets = getSshConnectionStore()?.listTargets() ?? []
        const targetId = resolvePinnedTerminalPanelSshTargetId(targets, args.host)
        const target = targets.find((candidate) => candidate.id === targetId)
        if (!target) {
          // Why: same policy as pinned panels — an unresolvable host must not
          // fall back to running the command locally.
          return { ok: false as const, error: 'host-unresolved' }
        }
        // Why: buildSshArgs emits -T (relay/exec transport); a TUI tile needs
        // a remote tty, so swap it for -tt.
        const sshArgs = buildSshArgs(target).map((arg) => (arg === '-T' ? '-tt' : arg))
        file = findSystemSsh() ?? 'ssh'
        spawnArgs = [...sshArgs, command]
      } else {
        file = process.env.SHELL || '/bin/bash'
        spawnArgs = ['-lc', command]
      }

      let proc: pty.IPty
      try {
        proc = pty.spawn(file, spawnArgs, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: process.env.HOME || process.cwd(),
          env
        })
      } catch (error) {
        return { ok: false as const, error: String(error) }
      }
      const id = `popout-pty-${nextPopoutPtyId++}`
      const sender = event.sender
      popoutPtys.set(id, { proc, ownerWebContentsId: sender.id })
      proc.onData((data) => {
        if (!sender.isDestroyed()) {
          sender.send('popoutPty:data', { id, data })
        }
      })
      proc.onExit(({ exitCode }) => {
        popoutPtys.delete(id)
        if (!sender.isDestroyed()) {
          sender.send('popoutPty:exit', { id, exitCode })
        }
      })
      return { ok: true as const, id }
    }
  )

  ipcMain.handle('popoutPty:input', (event, args: { id: string; data: string }) => {
    const session = popoutPtys.get(args?.id ?? '')
    if (session && session.ownerWebContentsId === event.sender.id) {
      session.proc.write(args.data)
    }
  })

  ipcMain.handle('popoutPty:resize', (event, args: { id: string; cols: number; rows: number }) => {
    const session = popoutPtys.get(args?.id ?? '')
    if (
      session &&
      session.ownerWebContentsId === event.sender.id &&
      Number.isInteger(args.cols) &&
      Number.isInteger(args.rows) &&
      args.cols > 0 &&
      args.rows > 0
    ) {
      try {
        session.proc.resize(args.cols, args.rows)
      } catch {
        // Why: resize on an exiting pty throws; the exit event cleans up.
      }
    }
  })

  ipcMain.handle('popoutPty:kill', (event, args: { id: string }) => {
    const session = popoutPtys.get(args?.id ?? '')
    if (session && session.ownerWebContentsId === event.sender.id) {
      popoutPtys.delete(args.id)
      try {
        session.proc.kill()
      } catch {
        // Why: the process may already be gone; reaping must not throw.
      }
    }
  })
}
