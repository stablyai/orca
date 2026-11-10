// Private build only: `orca cloud …` handlers. They never touch the Orca runtime (ctx.client): they
// call the Orca Cloud public API over HTTPS, so they work inside a VM with no desktop app running.
import type { CommandHandler } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime/types'
import { CloudApiClient } from './cloud-api-client'
import {
  describeCloudToken,
  normalizeCloudApiUrl,
  removeCloudCredentials,
  resolveCloudCredentials,
  writeCloudCredentials,
  type CloudCredentials
} from './cloud-credentials'
import {
  formatCloudMessage,
  formatCloudMessageList,
  formatCloudProjects,
  formatCloudSessions,
  formatCloudWhoami,
  formatCloudWorkspace,
  formatCloudWorkspaceList,
  printCloudResult,
  type CloudMe,
  type CloudMessage,
  type CloudProject,
  type CloudSession,
  type CloudWorkspace
} from './cloud-format'
import {
  DEFAULT_MESSAGE_WAIT_S,
  cloudClient,
  createCloudWorkspace,
  defaultCloudHandlerDeps,
  getAgentFlag,
  getSizeFlag,
  normalizeCloudRepoUrl,
  readMessageFlags,
  resolveCloudProjectId,
  resolveCloudWorkspaceId,
  waitForCloudMessage,
  workspacePath,
  type CloudHandlerDeps,
  type CloudWorkspaceCreateInput
} from './cloud-operations'

import { cloudLifecycleHandler, type CloudLifecycleAction } from './cloud-lifecycle'

export type { CloudHandlerDeps } from './cloud-operations'

export function createCloudHandlers(
  getDeps: () => CloudHandlerDeps = defaultCloudHandlerDeps
): Record<string, CommandHandler> {
  const mutate = (action: CloudLifecycleAction) => cloudLifecycleHandler(action, getDeps)

  return {
    'cloud whoami': async ({ json }) => {
      const deps = getDeps()
      const api = cloudClient(deps)
      const me = await api.request<CloudMe>('GET', '/v1/me')
      printCloudResult(
        {
          me,
          apiUrl: api.credentials.apiUrl,
          credentialSource:
            api.credentials.source === 'env'
              ? 'ORCA_CLOUD_TOKEN'
              : (api.credentials.path ?? 'file'),
          tokenKind: describeCloudToken(api.credentials.token)
        },
        json,
        formatCloudWhoami
      )
    },
    'cloud login': async ({ flags, json }) => {
      const deps = getDeps()
      const flagToken = getOptionalStringFlag(flags, 'token')
      const token = (flagToken ?? (await deps.readStdin()) ?? '').trim()
      if (!token) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Pass --token <token>, or pipe the token on stdin (keeps it out of shell history).',
          { field: 'token' }
        )
      }
      let existingUrl: string | null = null
      try {
        existingUrl = resolveCloudCredentials(
          { ...deps.env, ORCA_CLOUD_TOKEN: undefined },
          { fs: deps.fs, home: deps.home }
        ).apiUrl
      } catch {
        existingUrl = null
      }
      const rawUrl =
        getOptionalStringFlag(flags, 'api-url') ??
        deps.env.ORCA_CLOUD_API_URL?.trim() ??
        deps.env.ORCA_CLOUD_SANDBOX_URL?.trim() ??
        existingUrl
      if (!rawUrl) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Pass --api-url <control-plane-url> (first login only).',
          {
            field: 'api-url'
          }
        )
      }
      const apiUrl = normalizeCloudApiUrl(rawUrl, '--api-url')
      const credentials: CloudCredentials = {
        apiUrl,
        token,
        workspaceId: null,
        source: 'file',
        path: null
      }
      // Check before saving, so a typo never replaces working credentials.
      const me = await new CloudApiClient(credentials, deps.fetch).request<CloudMe>('GET', '/v1/me')
      const path = writeCloudCredentials(
        deps.env,
        { apiUrl, token, workspaceId: me.workspaceId ?? null },
        { fs: deps.fs, home: deps.home }
      )
      printCloudResult(
        { me, apiUrl, path, tokenKind: describeCloudToken(token) },
        json,
        (value) =>
          `Signed in to ${value.apiUrl} as ${value.me.userId} (${value.me.accountId}, ${value.tokenKind}).\nSaved to ${value.path}`
      )
    },
    'cloud logout': async ({ json }) => {
      const deps = getDeps()
      const result = removeCloudCredentials(deps.env, { fs: deps.fs, home: deps.home })
      printCloudResult(result, json, (value) =>
        value.removed ? `Removed ${value.path}` : `No credentials at ${value.path}`
      )
    },
    'cloud workspace list': async ({ flags, json }) => {
      const deps = getDeps()
      const api = cloudClient(deps)
      const all = flags.get('all') === true
      const include = [
        ...(all || flags.get('include-archived') === true ? ['archived'] : []),
        ...(all ? ['hidden'] : [])
      ]
      const project = getOptionalStringFlag(flags, 'project')
      const result = await api.request<{ workspaces: CloudWorkspace[] }>('GET', '/v1/workspaces', {
        query: {
          ...(include.length > 0 ? { include: include.join(',') } : {}),
          ...(project ? { projectId: await resolveCloudProjectId(api, project) } : {})
        }
      })
      printCloudResult(result, json, (value) => formatCloudWorkspaceList(value, deps.now()))
    },
    'cloud workspace show': async ({ flags, json }) => {
      const deps = getDeps()
      const api = cloudClient(deps)
      const id = await resolveCloudWorkspaceId(api, getRequiredStringFlag(flags, 'workspace'))
      const result = await api.request<{ workspace: CloudWorkspace }>('GET', workspacePath(id))
      printCloudResult(result, json, (value) => formatCloudWorkspace(value, deps.now()))
    },
    'cloud workspace create': async ({ flags, json }) => {
      const deps = getDeps()
      const agent = getAgentFlag(flags)
      const prompt = getOptionalStringFlag(flags, 'prompt')
      if (agent && !prompt) {
        throw new RuntimeClientError(
          'invalid_argument',
          '--agent needs --prompt (the first message).',
          {
            field: 'prompt'
          }
        )
      }
      const repoFlag = getOptionalStringFlag(flags, 'repo')
      const ref = getOptionalStringFlag(flags, 'ref')
      if (ref && !repoFlag) {
        throw new RuntimeClientError('invalid_argument', '--ref needs --repo.', { field: 'ref' })
      }
      const machineSize = getSizeFlag(flags)
      const api = cloudClient(deps)
      const project = getOptionalStringFlag(flags, 'project')
      const name = getOptionalStringFlag(flags, 'name')
      const region = getOptionalStringFlag(flags, 'region')
      const input: CloudWorkspaceCreateInput = {
        ...(name ? { name } : {}),
        ...(project ? { projectId: await resolveCloudProjectId(api, project) } : {}),
        ...(repoFlag
          ? { repo: { url: normalizeCloudRepoUrl(repoFlag), ...(ref ? { ref } : {}) } }
          : {}),
        ...(machineSize ? { machineSize } : {}),
        ...(region ? { region } : {}),
        ...(prompt ? { message: { text: prompt, ...(agent ? { agent } : {}) } } : {})
      }
      const result = await createCloudWorkspace(api, input, deps.now)
      printCloudResult(result, json, (value) => formatCloudWorkspace(value, deps.now()))
    },
    'cloud workspace sleep': mutate('sleep'),
    'cloud workspace wake': mutate('wake'),
    'cloud workspace archive': mutate('archive'),
    'cloud workspace destroy': mutate('destroy'),
    'cloud message': async ({ flags, json }) => {
      const deps = getDeps()
      const body = readMessageFlags(flags)
      const waitSeconds = getOptionalPositiveIntegerFlag(flags, 'timeout') ?? DEFAULT_MESSAGE_WAIT_S
      const api = cloudClient(deps)
      const id = await resolveCloudWorkspaceId(api, getRequiredStringFlag(flags, 'workspace'))
      const started = deps.now()
      const { message } = await api.request<{ message: CloudMessage }>(
        'POST',
        workspacePath(id, '/messages'),
        {
          body
        }
      )
      if (flags.get('wait') !== true) {
        printCloudResult({ message }, json, formatCloudMessage)
        return
      }
      const delivered = await waitForCloudMessage(api, deps, message, waitSeconds * 1000)
      printCloudResult(
        { message: delivered, waitedMs: deps.now() - started },
        json,
        formatCloudMessage
      )
    },
    'cloud messages': async ({ flags, json }) => {
      const deps = getDeps()
      const api = cloudClient(deps)
      const id = await resolveCloudWorkspaceId(api, getRequiredStringFlag(flags, 'workspace'))
      const messageId = getOptionalStringFlag(flags, 'message')
      if (!messageId) {
        const result = await api.request<{ messages: CloudMessage[] }>(
          'GET',
          workspacePath(id, '/messages')
        )
        printCloudResult(result, json, formatCloudMessageList)
        return
      }
      const result = await api.request<{ message: CloudMessage }>(
        'GET',
        workspacePath(id, `/messages/${encodeURIComponent(messageId)}`)
      )
      printCloudResult(result, json, formatCloudMessage)
    },
    'cloud sessions': async ({ flags, json }) => {
      const deps = getDeps()
      const api = cloudClient(deps)
      const id = await resolveCloudWorkspaceId(api, getRequiredStringFlag(flags, 'workspace'))
      const result = await api.request<{ workspaceStatus: string; sessions: CloudSession[] }>(
        'GET',
        workspacePath(id, '/sessions'),
        { timeoutMs: 90_000 }
      )
      printCloudResult(result, json, (value) => formatCloudSessions(value, deps.now()))
    },
    'cloud projects list': async ({ json }) => {
      const deps = getDeps()
      const api = cloudClient(deps)
      const result = await api.request<{ projects: CloudProject[] }>('GET', '/v1/projects')
      printCloudResult(result, json, formatCloudProjects)
    }
  }
}

export const CLOUD_HANDLERS = createCloudHandlers()
