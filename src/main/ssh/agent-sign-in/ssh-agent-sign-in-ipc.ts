// IPC for classic SSH agent sign-in: status (connected hosts only, 60 s cache), code sign-in and
// sign-out over remote exec. Requests are validated; replies are verdicts, links and flow phases.
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { HOST_AGENT_SIGN_IN_AGENTS } from '../../../shared/host-agent-sign-in-status'
import type {
  SshAgentSignInFlow,
  SshAgentSignInStatusResult
} from '../../../shared/ssh-agent-sign-in-types'
import { getSshConnectionManager } from '../targets/ssh-target-registry'
import { execCommand } from '../remote-exec/remote-exec-command'
import { SshAgentSignInFlows, type SshLoginTransport } from './ssh-agent-sign-in-flows'
import { SshAgentSignInStatus } from './ssh-agent-sign-in-status'

const CHANNELS = [
  'sshAgentSignIn:status',
  'sshAgentSignIn:start',
  'sshAgentSignIn:submitCode',
  'sshAgentSignIn:cancel',
  'sshAgentSignIn:flows',
  'sshAgentSignIn:signOut'
] as const

const Agent = z.enum(HOST_AGENT_SIGN_IN_AGENTS)
const Target = z.string().min(1).max(512)
const StatusRequest = z.object({ targetId: Target, force: z.boolean().optional() }).strict()
const AgentRequest = z.object({ targetId: Target, agent: Agent }).strict()
const CodeRequest = z.object({ flowId: z.string().uuid(), code: z.string().max(512) }).strict()
const FlowRequest = z.object({ flowId: z.string().uuid() }).strict()
const TargetRequest = z.object({ targetId: Target }).strict()

const LOGOUT_COMMAND = { claude: 'claude auth logout', codex: 'codex logout' } as const
const LOGOUT_TIMEOUT_MS = 15_000

function connectedTransport(targetId: string) {
  const conn = getSshConnectionManager()?.getConnection(targetId)
  if (!conn || conn.getState().status !== 'connected') {
    return null
  }
  return conn
}

/** Adapts the host's SSH exec channel to the login flow; output stays in main. */
function loginTransport(targetId: string): SshLoginTransport | null {
  const conn = connectedTransport(targetId)
  if (!conn) {
    return null
  }
  return {
    exec: async (command, options) => {
      const channel = await conn.exec(command, options)
      return {
        onOutput: (listener) => {
          const read = (chunk: Buffer | string): void => listener(chunk.toString())
          channel.on('data', read)
          channel.stderr.on('data', read)
        },
        onClose: (listener) => {
          channel.on('close', (code: number | null) => listener(code))
        },
        onError: (listener) => {
          channel.on('error', () => listener())
        },
        write: (text) => {
          channel.stdin.write(text)
        },
        close: () => channel.close()
      }
    }
  }
}

function broadcast(flow: SshAgentSignInFlow): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('sshAgentSignIn:flowChanged', flow)
    }
  }
}

let status: SshAgentSignInStatus | null = null
let flows: SshAgentSignInFlows | null = null

export function registerSshAgentSignInHandlers(): void {
  status ??= new SshAgentSignInStatus((targetId) => {
    const conn = connectedTransport(targetId)
    return conn
      ? {
          exec: (command, options) => conn.exec(command, options),
          usesSystemSshTransport: () => conn.usesSystemSshTransport(),
          getConnectGeneration: () => conn.getConnectGeneration(),
          connected: () => conn.getState().status === 'connected'
        }
      : null
  })
  const statusService = status
  flows ??= new SshAgentSignInFlows(loginTransport, broadcast, (targetId) =>
    statusService.forget(targetId)
  )
  const flowService = flows
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  const disconnected: SshAgentSignInStatusResult = { ok: false, error: 'disconnected' }

  ipcMain.handle('sshAgentSignIn:status', (_event, raw: unknown) => {
    const request = StatusRequest.safeParse(raw)
    return request.success
      ? statusService.read(request.data.targetId, request.data.force === true)
      : disconnected
  })
  ipcMain.handle('sshAgentSignIn:start', (_event, raw: unknown) => {
    const request = AgentRequest.safeParse(raw)
    return request.success ? flowService.start(request.data.targetId, request.data.agent) : null
  })
  ipcMain.handle('sshAgentSignIn:submitCode', (_event, raw: unknown) => {
    const request = CodeRequest.safeParse(raw)
    return request.success ? flowService.submitCode(request.data.flowId, request.data.code) : false
  })
  ipcMain.handle('sshAgentSignIn:cancel', (_event, raw: unknown) => {
    const request = FlowRequest.safeParse(raw)
    if (request.success) {
      flowService.cancel(request.data.flowId)
    }
  })
  ipcMain.handle('sshAgentSignIn:flows', (_event, raw: unknown) => {
    const request = TargetRequest.safeParse(raw)
    return request.success ? flowService.list(request.data.targetId) : []
  })
  ipcMain.handle('sshAgentSignIn:signOut', async (_event, raw: unknown) => {
    const request = AgentRequest.safeParse(raw)
    if (!request.success) {
      return disconnected
    }
    const { targetId, agent } = request.data
    const conn = connectedTransport(targetId)
    if (!conn) {
      return disconnected
    }
    // The CLI's own sign-out; its output stays here.
    await execCommand(conn, LOGOUT_COMMAND[agent], { timeoutMs: LOGOUT_TIMEOUT_MS }).catch(
      () => undefined
    )
    statusService.forget(targetId)
    return statusService.read(targetId, true)
  })
}
