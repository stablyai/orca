// Renderer bridge for the one-time Orca Cloud agent setup (spec §5 S0). Replies are states and codes:
// the Claude setup-token is captured and sent from main, and a pasted token goes renderer -> main once.
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import { z } from 'zod'
import {
  ORCA_CLOUD_ACCOUNT_AGENTS,
  type OrcaCloudAgentSetups
} from '../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { withCloudBuildDefaults } from '../cloud-build-defaults'
import { getHostedSandboxConfig } from '../hosted-sandbox/hosted-sandbox-config'
import { orcaCloudSandboxIdFor } from '../hosted-sandbox/orca-cloud-sandbox-id'
import { claudeStateFile, readClaudeFolderLogin } from '../claude-accounts/claude-account-folder'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getOrcaProfileIndexGeneration } from '../orca-profiles/profile-index-generation'
import { createAgentCredentialsClient } from './agent-credentials-client'
import { spawnClaudeSetupTokenPty } from './claude-setup-token-pty'
import {
  createOrcaCloudAgentsService,
  type OrcaCloudAgentsService
} from './orca-cloud-agents-service'

export const ORCA_CLOUD_AGENTS_SETUP_CHANGED = 'orcaCloudAgents:setupChanged'

const Agent = z.enum(ORCA_CLOUD_ACCOUNT_AGENTS)
const AgentRequest = z.object({ agent: Agent })
// Bounded well above a real token; the service checks the exact shape.
const PasteRequest = z.object({ token: z.string().min(1).max(1024) })
// The code (or callback URL) from Claude's sign-in page; main normalizes it.
const CodeRequest = z.object({ code: z.string().min(1).max(2048) })
const SourceRequest = z.object({ agent: Agent, source: z.enum(['sign-in', 'key']).nullable() })
// A runtime environment, never a raw sandbox id: main resolves only sandboxes this desktop made.
const RuntimeEnvironment = z.string().min(1).max(256)
const WorkspaceRequest = z.object({ runtimeEnvironmentId: RuntimeEnvironment })
const WorkspaceSourceRequest = SourceRequest.extend({ runtimeEnvironmentId: RuntimeEnvironment })

const CHANNELS = [
  'orcaCloudAgents:submitClaudeCode',
  'orcaCloudAgents:status',
  'orcaCloudAgents:setups',
  'orcaCloudAgents:start',
  'orcaCloudAgents:cancel',
  'orcaCloudAgents:reopen',
  'orcaCloudAgents:usePaste',
  'orcaCloudAgents:pasteClaudeToken',
  'orcaCloudAgents:acknowledge',
  'orcaCloudAgents:remove',
  'orcaCloudAgents:setDefaultSource',
  'orcaCloudAgents:workspaceSources',
  'orcaCloudAgents:setWorkspaceSource'
] as const

function broadcast(setups: OrcaCloudAgentSetups): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(ORCA_CLOUD_AGENTS_SETUP_CHANGED, setups)
    }
  }
}

function readClaudeEmail(): string | null {
  try {
    return readClaudeFolderLogin(claudeStateFile(process.env.CLAUDE_CONFIG_DIR))?.email ?? null
  } catch {
    return null
  }
}

/** The signed-in Orca user, re-read only when the profile index changes (sign-in, sign-out, switch). */
function orcaIdentityReader(userDataPath: string): () => string | null {
  let cached: { generation: number; identity: string | null } | null = null
  return () => {
    const generation = getOrcaProfileIndexGeneration()
    if (cached?.generation !== generation) {
      let identity: string | null = null
      try {
        const active = ensureActiveOrcaProfile(userDataPath)
        const userId = active.profile.cloud?.userId
        identity = userId ? `${active.profile.id}:${userId}` : null
      } catch {
        identity = null
      }
      cached = { generation, identity }
    }
    return cached.identity
  }
}

// One per app: a setup running when a window reattaches keeps going instead of being orphaned.
let shared: OrcaCloudAgentsService | null = null

function serviceFor(userDataPath: string): OrcaCloudAgentsService {
  if (shared) {
    return shared
  }
  const config = getHostedSandboxConfig(
    userDataPath,
    withCloudBuildDefaults(process.env),
    app.isPackaged
  )
  shared = createOrcaCloudAgentsService({
    client: config
      ? createAgentCredentialsClient({
          baseUrl: config.controlPlaneUrl,
          getAccessToken: config.getAccessToken
        })
      : null,
    spawnSetupToken: spawnClaudeSetupTokenPty,
    readClaudeEmail,
    openExternal: (url) => shell.openExternal(url),
    broadcast,
    identity: orcaIdentityReader(userDataPath)
  })
  return shared
}

export function registerOrcaCloudAgentsHandlers(userDataPath: string): void {
  const service = serviceFor(userDataPath)
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  // A malformed request is a renderer bug, not something the user typed.
  const invalid = { ok: false, error: 'unknown' } as const

  ipcMain.handle('orcaCloudAgents:status', () => service.status())
  ipcMain.handle('orcaCloudAgents:setups', () => service.setups())
  ipcMain.handle('orcaCloudAgents:start', (_event, raw: unknown) => {
    const request = AgentRequest.safeParse(raw)
    return request.success ? service.start(request.data.agent) : invalid
  })
  ipcMain.handle('orcaCloudAgents:cancel', async (_event, raw: unknown) => {
    const request = AgentRequest.safeParse(raw)
    if (request.success) {
      await service.cancel(request.data.agent)
    }
  })
  ipcMain.handle('orcaCloudAgents:reopen', (_event, raw: unknown) => {
    const request = AgentRequest.safeParse(raw)
    return request.success ? service.reopen(request.data.agent) : false
  })
  ipcMain.handle('orcaCloudAgents:usePaste', () => service.usePaste())
  ipcMain.handle('orcaCloudAgents:submitClaudeCode', (_event, raw: unknown) => {
    const request = CodeRequest.safeParse(raw)
    return request.success ? service.submitClaudeCode(request.data.code) : invalid
  })
  ipcMain.handle('orcaCloudAgents:pasteClaudeToken', (_event, raw: unknown) => {
    const request = PasteRequest.safeParse(raw)
    return request.success ? service.pasteClaudeToken(request.data.token) : invalid
  })
  ipcMain.handle('orcaCloudAgents:acknowledge', (_event, raw: unknown) => {
    const request = AgentRequest.safeParse(raw)
    if (request.success) {
      service.acknowledge(request.data.agent)
    }
  })
  ipcMain.handle('orcaCloudAgents:remove', (_event, raw: unknown) => {
    const request = AgentRequest.safeParse(raw)
    return request.success ? service.remove(request.data.agent) : invalid
  })
  ipcMain.handle('orcaCloudAgents:setDefaultSource', (_event, raw: unknown) => {
    const request = SourceRequest.safeParse(raw)
    return request.success
      ? service.setDefaultSource(request.data.agent, request.data.source)
      : invalid
  })
  // Before the sandbox exists there is no workspace to name: the reply is not_found.
  const notFound = { ok: false, error: 'not_found' } as const
  ipcMain.handle('orcaCloudAgents:workspaceSources', (_event, raw: unknown) => {
    const request = WorkspaceRequest.safeParse(raw)
    if (!request.success) {
      return invalid
    }
    const workspaceId = orcaCloudSandboxIdFor(userDataPath, request.data.runtimeEnvironmentId)
    return workspaceId ? service.workspaceSources(workspaceId) : notFound
  })
  ipcMain.handle('orcaCloudAgents:setWorkspaceSource', (_event, raw: unknown) => {
    const request = WorkspaceSourceRequest.safeParse(raw)
    if (!request.success) {
      return invalid
    }
    const workspaceId = orcaCloudSandboxIdFor(userDataPath, request.data.runtimeEnvironmentId)
    return workspaceId
      ? service.setWorkspaceSource(request.data.agent, request.data.source, workspaceId)
      : notFound
  })
}
