import type { Translate } from '../i18n/mobile-i18n'
import { isRpcDeliveryUnknown } from '../transport/rpc/rpc-delivery-ambiguity'
import type { CloudWorkspace } from './cloud-control-plane-client'
import { CloudRequestError } from './cloud-control-plane-request'
import { CloudAttachError, type CloudAttachPhase } from './cloud-workspace-attach'
import { formatElapsed } from './cloud-workspace-display'

// What the cloud workspace screen says about each state and failure.

export function attachErrorMessage(error: unknown, t: Translate): string {
  if (error instanceof CloudAttachError) {
    switch (error.code) {
      case 'archived':
        return t(
          'cloud.error.archived',
          'This workspace is archived. Unarchive it on your computer first.'
        )
      case 'wake_timeout':
        return t(
          'cloud.error.wakeTimeout',
          'The sandbox is taking longer than usual to wake. Your files are safe.'
        )
      case 'grant_failed':
        return t(
          'cloud.error.grant',
          'This phone couldn’t get access to the workspace. Your files are safe.'
        )
      case 'pairing_failed':
        return t(
          'cloud.error.pairing',
          'The workspace is running, but this phone couldn’t connect to it. Your files are safe.'
        )
      default:
        return t(
          'cloud.error.failed',
          'The workspace couldn’t start. Try again, or open it on your desktop.'
        )
    }
  }
  if (error instanceof CloudRequestError) {
    if (error.status === 401) {
      return t(
        'cloud.error.revoked',
        'This phone’s Orca Cloud access ended. Connect it again from Home.'
      )
    }
    if (error.code === 'entitlement_denied') {
      return t(
        'cloud.error.entitlement',
        'Out of sandbox hours. Ask an owner or admin to add hours, then try again.'
      )
    }
    if (error.code === 'network_error' || error.code === 'timeout') {
      return t(
        'cloud.error.network',
        'Couldn’t reach Orca Cloud. Check your connection and try again.'
      )
    }
  }
  return t('cloud.error.generic', 'Something went wrong. Your files are safe.')
}

export function phaseLabel(phase: CloudAttachPhase, t: Translate): string {
  switch (phase) {
    case 'waking':
      return t('cloud.phase.waking', 'Waking the sandbox')
    case 'granting':
      return t('cloud.phase.granting', 'Getting this phone access')
    case 'pairing':
      return t('cloud.phase.pairing', 'Connecting securely')
    case 'connected':
      return t('cloud.phase.connected', 'Connected')
  }
}

export function statusSentence(
  workspace: CloudWorkspace,
  t: Translate,
  uptimeMs: number | null
): string {
  switch (workspace.status) {
    case 'running':
      return uptimeMs !== null
        ? t(
            'cloud.line.runningFor',
            'Up {{elapsed}}. Agents keep working when you close the app.',
            { elapsed: formatElapsed(uptimeMs) }
          )
        : t('cloud.line.running', 'Agents keep working when you close the app.')
    case 'sleeping':
      return t('cloud.line.sleeping', 'Files are kept, and waking takes about 5 seconds.')
    case 'creating':
      return t('cloud.line.creating', 'Starting the sandbox and cloning the repository.')
    case 'waking':
      return t('cloud.line.waking', 'Starting up. This usually takes about 5 seconds.')
    case 'stopping':
      return t('cloud.line.stopping', 'Files are kept.')
    case 'archived':
      return t('cloud.line.archived', 'Unarchive it on your computer to work in it again.')
    case 'failed':
      return t('cloud.line.failed', 'The sandbox couldn’t start. Your files are safe.')
  }
}

const PROMPT_ERROR_CODES = ['cloud_project_unavailable', 'cloud_agent_unknown'] as const

/** What a failed prompt keeps: a known code, never raw host text (it may be untranslated or long). */
export function cloudPromptErrorCode(error: unknown): string {
  // The launch may have reached the host: keep the operation id so a retry is deduped, never doubled.
  if (isRpcDeliveryUnknown(error)) {
    return 'transport_lost'
  }
  const message = error instanceof Error ? error.message : ''
  return PROMPT_ERROR_CODES.find((code) => message.includes(code)) ?? 'launch_failed'
}

export function cloudPromptErrorMessage(code: string | undefined, t: Translate): string {
  switch (code) {
    case 'cloud_project_unavailable':
      return t('cloud.prompt.errorProject', 'The workspace’s project isn’t ready yet')
    case 'transport_lost':
      return t('cloud.prompt.errorTransport', 'The connection dropped while sending')
    case 'not_connected':
      return t('cloud.prompt.errorNotConnected', 'This phone couldn’t reach the workspace')
    case 'cloud_agent_unknown':
      return t('cloud.prompt.errorAgent', 'That agent isn’t installed in this workspace')
    default:
      return t('cloud.prompt.errorLaunch', 'The agent didn’t start')
  }
}

export function createErrorMessage(error: unknown, t: Translate): string {
  if (error instanceof CloudRequestError) {
    if (error.status === 401) {
      return t(
        'cloud.error.revoked',
        'This phone’s Orca Cloud access ended. Connect it again from Home.'
      )
    }
    if (error.code === 'entitlement_denied') {
      return error.reason === 'concurrency_limit'
        ? t(
            'cloud.error.concurrency',
            'You’re at your team’s limit of running sandboxes. Put one to sleep or delete it, then try again.'
          )
        : t(
            'cloud.error.entitlement',
            'Out of sandbox hours. Ask an owner or admin to add hours, then try again.'
          )
    }
    if (error.code === 'provider_unavailable' && error.reason === 'orcad_start_failed') {
      return t(
        'cloud.error.clone',
        'Couldn’t clone the repository. Check the name and that the Orca Cloud GitHub app can see it. Nothing was created, and you weren’t charged.'
      )
    }
    if (error.code === 'timeout' || error.code === 'network_error' || error.status >= 500) {
      return t(
        'cloud.error.createUnknown',
        'Lost the connection while starting it. It may still appear in your list. Try again to pick it up.'
      )
    }
    if (error.code === 'rate_limited') {
      return t(
        'cloud.error.rateLimited',
        'Too many new workspaces at once. Wait a minute, then try again.'
      )
    }
  }
  return t(
    'cloud.error.create',
    'Couldn’t start your cloud workspace. Nothing was created, and you weren’t charged.'
  )
}
