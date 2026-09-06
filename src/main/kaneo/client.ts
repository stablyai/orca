import { normalizeKaneoSiteUrl, parseKaneoTaskUrl } from '../../shared/kaneo-task-url'
import type { KaneoConnectArgs, KaneoTask } from '../../shared/kaneo-types'
import { getKaneoStatus, readKaneoCredential, saveKaneoCredential } from './credential-store'
import { getMainHttpClient } from '../network/http-client'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const MAX_RESPONSE_BYTES = 512 * 1024

async function request(
  credential: KaneoConnectArgs,
  path: string,
  signal?: AbortSignal
): Promise<unknown> {
  const timeout = AbortSignal.timeout(15_000)
  const httpClient = getMainHttpClient()
  const response = await httpClient.fetch(`${credential.siteUrl}/api${path}`, {
    headers: { Authorization: `Bearer ${credential.apiKey}`, Accept: 'application/json' },
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    if (response.status === 401) {
      throw new Error('Kaneo rejected the API key. Reconnect Kaneo in Settings → Integrations.')
    }
    if (response.status === 403) {
      throw new Error('You do not have access to this Kaneo resource.')
    }
    if (response.status === 404) {
      throw new Error('Kaneo task or project not found.')
    }
    if (response.status === 429) {
      throw new Error('Kaneo is rate limiting requests. Try again shortly.')
    }
    throw new Error(`Kaneo request failed (HTTP ${response.status}).`)
  }
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Kaneo returned an empty response.')
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      bytes += result.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error('Kaneo response exceeded the size limit.')
      }
      chunks.push(result.value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error('Kaneo returned an invalid JSON response.')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Kaneo returned an invalid response.')
  }
  return value as Record<string, unknown>
}

export async function connectKaneo(args: KaneoConnectArgs) {
  const siteUrl = normalizeKaneoSiteUrl(args.siteUrl)
  const apiKey = args.apiKey.trim()
  if (
    !apiKey ||
    Array.from(apiKey).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error('Enter a valid Kaneo API key.')
  }
  const credential = { siteUrl, apiKey }
  const workspaces = await request(credential, '/auth/organization/list')
  if (!Array.isArray(workspaces)) {
    throw new Error('The address did not return a Kaneo workspace list.')
  }
  saveKaneoCredential(credential)
  return getKaneoStatus()
}

export async function getKaneoTask(url: string, signal?: AbortSignal): Promise<KaneoTask> {
  const link = parseKaneoTaskUrl(url)
  if (!link) {
    throw new Error('Enter a valid Kaneo task URL.')
  }
  const status = getKaneoStatus()
  if (!status.connected) {
    throw new Error('Connect Kaneo in Settings → Integrations to open this task.')
  }
  if (status.siteUrl !== link.siteUrl) {
    throw new Error(
      'This task belongs to a different Kaneo instance. Connect that instance in Settings → Integrations.'
    )
  }
  const credential = readKaneoCredential()
  if (!credential || credential.siteUrl !== link.siteUrl) {
    throw new Error('Reconnect this Kaneo instance in Settings → Integrations.')
  }
  const controller = new AbortController()
  const lookupSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const [taskValue, projectsValue] = await Promise.all([
    request(credential, `/task/${encodeURIComponent(link.taskId)}`, lookupSignal),
    request(
      credential,
      `/project?workspaceId=${encodeURIComponent(link.workspaceId)}&includeArchived=true`,
      lookupSignal
    )
  ]).catch((error: unknown) => {
    controller.abort()
    throw error
  })
  const task = record(taskValue)
  const project = Array.isArray(projectsValue)
    ? (projectsValue.find(
        (value: unknown) =>
          value !== null &&
          typeof value === 'object' &&
          (value as Record<string, unknown>).id === link.projectId
      ) as Record<string, unknown> | undefined)
    : undefined
  if (
    task.id !== link.taskId ||
    task.projectId !== link.projectId ||
    project?.id !== link.projectId ||
    project.workspaceId !== link.workspaceId
  ) {
    throw new Error('The Kaneo task does not match the project and workspace in this URL.')
  }
  if (typeof task.title !== 'string' || !task.title.trim()) {
    throw new Error('Kaneo returned a task without a title.')
  }
  return {
    ...link,
    title: task.title.trim().slice(0, 1000),
    description: typeof task.description === 'string' ? task.description.slice(0, 12000) : '',
    status: typeof task.status === 'string' ? task.status.slice(0, 100) : '',
    number:
      typeof task.number === 'number' && Number.isSafeInteger(task.number) && task.number > 0
        ? task.number
        : 0
  }
}
