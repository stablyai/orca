// Private build only: maps a control-plane error response to the CLI's error. Messages follow the
// product glossary's error tone: say what happened in plain words, say whether anything was lost or
// charged, give one next step. API codes and reasons stay in `error.data` (seen with --json).
import { RuntimeClientError } from '../runtime/connection/types'
import type { CloudCredentials } from './cloud-credentials'

type CloudApiErrorBody = { error?: unknown; reason?: unknown }

/** What the failed request was doing; create-time copy never says "Your files are safe". */
export type CloudRequestIntent = 'create' | 'existing'

type CloudApiErrorContext = {
  credentials: Pick<CloudCredentials, 'source' | 'token' | 'path'>
  retryAfter?: string | null
  intent?: CloudRequestIntent
  /** Request path; picks the 404 wording (workspace or routine). */
  path?: string
}

const NOTHING_CREATED = "Nothing was created, and you weren't charged."
const FILES_SAFE = 'Your files are safe.'
const BUSY_409 =
  'This workspace is still starting or going to sleep. Nothing was changed. Try again in a moment.'

/** "Try again in 12 seconds." (one second is singular). */
function tryAgainIn(seconds: number): string {
  return `Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`
}

function forbiddenMessage(reason: string | null): string {
  switch (reason) {
    case 'admin_required':
    case 'org_admin_required':
      return 'Only a team owner or admin can do this.'
    case 'session_required':
      return 'This needs a signed-in Orca session, not an Orca API key or workspace token.'
    case 'not_owner':
      return 'Only the person who created this can do that.'
    case null:
    default:
      return "You don't have access to do this."
  }
}

function conflictMessage(reason: string | null): { message: string; nextSteps: string[] } {
  if (reason === 'concurrent_transition' || (reason?.startsWith('sandbox_') ?? false)) {
    return { message: BUSY_409, nextSteps: [] }
  }
  switch (reason) {
    case 'workspace_not_running':
      return {
        message: "This workspace isn't running. Nothing was changed.",
        nextSteps: ['Wake it first: `orca cloud workspace wake <workspace>`.']
      }
    case 'idempotency_in_progress':
      return {
        message: 'The same request is still running. Nothing was changed. Try again in a moment.',
        nextSteps: []
      }
    case 'environment_not_built':
      return {
        message: `That environment has no finished build yet. ${NOTHING_CREATED}`,
        nextSteps: ['Build it first: `orca cloud env build --wait`.']
      }
    case 'region_unavailable':
      return {
        message: `That region isn't available right now. ${NOTHING_CREATED}`,
        nextSteps: ['Try again without --region.']
      }
    case 'github_not_connected':
      return {
        message: `Orca Cloud isn't connected to GitHub for this repo. ${NOTHING_CREATED}`,
        nextSteps: ['Connect GitHub in Orca → Settings → Orca Cloud, then try again.']
      }
    case 'queue_full':
      return {
        message: 'This routine already has runs waiting. Nothing was queued.',
        nextSteps: ['Try again after one of them finishes.']
      }
    case 'duplicate':
      return { message: 'The same run is already queued. Nothing was queued.', nextSteps: [] }
    case 'project_name_taken':
      return { message: 'A project with that name already exists.', nextSteps: [] }
    case null:
    default:
      return {
        message: "Orca Cloud couldn't do that right now. Nothing was changed.",
        nextSteps: ['Try again in a moment.']
      }
  }
}

/** Maps a control-plane error response to the CLI's error. */
export function cloudApiError(
  status: number,
  body: CloudApiErrorBody,
  context: CloudApiErrorContext
): RuntimeClientError {
  const code = typeof body.error === 'string' ? body.error : `http_${status}`
  const reason = typeof body.reason === 'string' ? body.reason : null
  const data = (nextSteps: string[], extra: Record<string, unknown> = {}) => ({
    status,
    apiError: code,
    ...(reason ? { reason } : {}),
    ...extra,
    ...(nextSteps.length > 0 ? { nextSteps } : {})
  })
  const creating = context.intent === 'create'
  const safety = creating ? NOTHING_CREATED : FILES_SAFE
  const inVm = context.credentials.token.startsWith('orca_ws_')
  if (status === 401) {
    return new RuntimeClientError(
      'cloud_unauthorized',
      inVm
        ? 'Orca Cloud rejected this workspace token. In-workspace CLI access may be turned off for the team (that revokes every workspace token at once), or the token was replaced at boot or revoked on sleep.'
        : 'Orca Cloud rejected the token: it is expired, revoked or for another Orca Cloud server.',
      data(
        inVm
          ? [
              'Ask a team owner or admin to turn on in-workspace CLI access in Orca Cloud settings, then restart the workspace for a fresh token.',
              'Or set ORCA_CLOUD_TOKEN to an Orca API key.'
            ]
          : context.credentials.source === 'env'
            ? ['Set ORCA_CLOUD_TOKEN to a valid Orca API key or session token.']
            : ['Run `orca cloud login --token <token>` with a fresh Orca API key or session token.']
      )
    )
  }
  if (status === 403 && reason === 'vm_cli_disabled') {
    return new RuntimeClientError(
      'cloud_vm_cli_disabled',
      'In-workspace CLI access is turned off for this team, so this workspace cannot call Orca Cloud.',
      data(
        ['Ask a team owner or admin to turn on in-workspace CLI access in Orca Cloud settings.'],
        { setting: 'vmCliEnabled' }
      )
    )
  }
  if (status === 403 && reason === 'own_workspace') {
    return new RuntimeClientError(
      'cloud_forbidden',
      "A workspace can't sleep, archive or delete itself. Nothing was changed.",
      data(['Pick another workspace.'])
    )
  }
  // Out of hours or at the spend cap, billing puts the team's running sandboxes to sleep (never deletes).
  const GO_TO_SLEEP = "Running sandboxes go to sleep and new ones can't start."
  if (
    code === 'entitlement_denied' &&
    (reason === 'concurrency_limit' || reason === 'member_concurrency_limit')
  ) {
    return new RuntimeClientError(
      'cloud_at_capacity',
      `${
        reason === 'member_concurrency_limit'
          ? "You're at your limit of running sandboxes."
          : "You're at your team's limit of running sandboxes."
      } ${creating ? 'Nothing was created.' : FILES_SAFE}`,
      data([
        'Put one to sleep or delete it, then try again: `orca cloud workspace list`, then `orca cloud workspace sleep <id>`.'
      ])
    )
  }
  if (code === 'entitlement_denied' || code === 'billing_required' || status === 402) {
    if (reason === 'payment_past_due' || reason === 'payment_grace_expired') {
      return new RuntimeClientError(
        'cloud_payment_failed',
        `Payment failed, so ${creating ? "new sandboxes can't start" : "this workspace can't wake"}. ${creating ? 'Nothing was created.' : FILES_SAFE}`,
        data(['Ask an owner or admin to update the payment method.'])
      )
    }
    if (reason === 'included_hours_exhausted') {
      return new RuntimeClientError(
        'cloud_out_of_hours',
        `Your team is out of sandbox hours. ${GO_TO_SLEEP} ${safety}`,
        data(['Ask an owner or admin to add hours.'])
      )
    }
    if (reason === 'overage_cap_reached') {
      return new RuntimeClientError(
        'cloud_spend_cap_reached',
        `Your team reached its monthly spend cap. ${GO_TO_SLEEP} ${safety}`,
        data(['Ask an owner or admin to raise the spend cap.'])
      )
    }
    if (reason === 'trial_used_up') {
      return new RuntimeClientError(
        'cloud_trial_used_up',
        `Your trial is used up. ${GO_TO_SLEEP} ${safety}`,
        data(['Ask an owner or admin to choose a plan in Orca → Settings → Plan & billing.'])
      )
    }
    if (reason === 'trial_unavailable') {
      return new RuntimeClientError(
        'cloud_plan_required',
        `This account or team already used its trial. ${safety}`,
        data(['Ask an owner or admin to choose a plan in Orca → Settings → Plan & billing.'])
      )
    }
    return new RuntimeClientError(
      'cloud_plan_required',
      `Orca Cloud needs a Team plan. ${safety}`,
      data(['Ask an owner or admin to start a Team plan in Orca → Settings → Plan & billing.'])
    )
  }
  if (status === 403 && code === 'insufficient_scope') {
    return new RuntimeClientError(
      'cloud_forbidden',
      `This Orca API key is missing the ${reason ?? 'required'} scope.`,
      data([
        'Create an Orca API key with that scope in the Orca Cloud console (Orca → Settings → API keys & connected apps), then run `orca cloud login`.'
      ])
    )
  }
  if (status === 403) {
    return new RuntimeClientError('cloud_forbidden', forbiddenMessage(reason), data([]))
  }
  if (status === 404) {
    const routine = context.path?.startsWith('/v1/routines') ?? false
    const noun = routine ? 'routine' : 'workspace'
    return new RuntimeClientError(
      'cloud_not_found',
      inVm && !routine
        ? "No workspace with that ID, or you don't have access to it. A workspace token sees only its own workspace and the workspaces it created."
        : `No ${noun} with that ID, or you don't have access to it.`,
      data([`Run \`orca cloud ${noun} list\` to see the ${noun}s you can use.`])
    )
  }
  if (status === 429) {
    const parsed = Number(context.retryAfter)
    const seconds = Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : 60
    return new RuntimeClientError(
      'cloud_rate_limited',
      reason === 'workspace_creates'
        ? `Too many new workspaces in a short time. ${NOTHING_CREATED}`
        : 'Too many requests to Orca Cloud right now.',
      data([tryAgainIn(seconds)], { retryAfterSeconds: Number.isFinite(parsed) ? parsed : null })
    )
  }
  if (status === 400) {
    // Reasons read "<field>: <problem>"; the field is useful, the problem text is API wording.
    const field = reason ? /^([A-Za-z0-9_.]+):/.exec(reason)?.[1] : undefined
    return new RuntimeClientError(
      'invalid_argument',
      field && field !== 'body'
        ? `Orca Cloud didn't accept the value for ${field}. Nothing was changed.`
        : "Orca Cloud didn't accept that request. Nothing was changed.",
      data([])
    )
  }
  if (status === 409) {
    const conflict = conflictMessage(reason)
    return new RuntimeClientError('cloud_conflict', conflict.message, data(conflict.nextSteps))
  }
  if (status === 503 && code === 'not_configured') {
    return new RuntimeClientError(
      'cloud_unavailable',
      "This Orca Cloud server can't run workspaces right now.",
      data([])
    )
  }
  if (status >= 500) {
    return new RuntimeClientError(
      'cloud_unavailable',
      "Orca Cloud couldn't finish that request.",
      data(['Try again in a moment.'])
    )
  }
  return new RuntimeClientError('cloud_api_error', "Orca Cloud couldn't do that.", data([]))
}
