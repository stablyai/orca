// Orca Cloud setup session (NP-4 N1), desktop side. "Set up and start" opens ONE browser tab:
// - signed out: the sign-in tab shows the setup account page (A2); once the code is exchanged,
//   the session is created and the same tab continues to the setup pages;
// - signed in: the session is created and its start URL is opened.
// The composer then polls getCloudSetupSession until every step is done.
import { appendFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { app, shell } from 'electron'
import { z } from 'zod'
import {
  CLOUD_SETUP_ERROR_KINDS,
  CLOUD_SETUP_SESSION_ID,
  type CloudSetupGetResult,
  type CloudSetupLinkResult,
  type CloudSetupNeed,
  type CloudSetupSession,
  type CloudSetupStartArgs,
  type CloudSetupStartResult
} from '../../shared/orca-cloud-setup'
import { connectCurrentOrcaProfile } from '../orca-profiles/cloud-auth/profile-cloud-service'
import { billingRequest, BillingServiceError, type BillingEndpoints } from './billing-client'
import { withBillingToken } from './billing-service'

const CreatedBody = z.object({
  id: z.string().regex(CLOUD_SETUP_SESSION_ID),
  url: z.string().url().startsWith('https://'),
  expiresAt: z.number()
})

const StepBody = z.object({
  id: z.enum(['account', 'team', 'plan', 'github']),
  state: z.enum(['done', 'needed', 'active', 'pending', 'failed', 'optional']),
  detail: z.string().max(200).optional()
})

const SessionBody = z.object({
  id: z.string().regex(CLOUD_SETUP_SESSION_ID),
  steps: z.array(StepBody).max(8),
  team: z
    .object({
      orgId: z.string().max(128),
      name: z.string().max(200).nullable(),
      created: z.boolean()
    })
    .nullable()
    .catch(null),
  trial: z
    .object({ includedSeconds: z.number(), usedSeconds: z.number(), exhausted: z.boolean() })
    .nullable()
    .catch(null),
  plan: z.enum(['subscription', 'trial']).nullable().catch(null),
  finished: z.boolean(),
  error: z
    .object({ kind: z.enum(CLOUD_SETUP_ERROR_KINDS), detail: z.string().max(320).optional() })
    .nullable()
    .catch(null),
  expiresAt: z.number()
})

/** What this Mac is called on the setup page ("Orca on MacBook Pro is waiting for you"). */
export function setupDeviceLabel(name = hostname()): string {
  return (
    name
      .replace(/\.local$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim()
      .slice(0, 80) || 'this computer'
  )
}

export async function createSetupSessionRequest(
  endpoints: BillingEndpoints,
  token: string,
  body: { repo?: string; needs: CloudSetupNeed[]; device: string; useActiveTeam: boolean },
  fetchImpl: typeof fetch = fetch
): Promise<z.infer<typeof CreatedBody>> {
  const created = CreatedBody.safeParse(
    await billingRequest(endpoints, token, 'POST', 'v1/cloud-setup/sessions', body, fetchImpl)
  )
  if (!created.success) {
    throw new Error('invalid_setup_session')
  }
  return created.data
}

export async function getSetupSessionRequest(
  endpoints: BillingEndpoints,
  token: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch
): Promise<CloudSetupSession> {
  const session = SessionBody.safeParse(
    await billingRequest(
      endpoints,
      token,
      'GET',
      `v1/cloud-setup/sessions/${sessionId}`,
      undefined,
      fetchImpl
    )
  )
  if (!session.success) {
    throw new Error('invalid_setup_session')
  }
  return session.data
}

async function openInBrowser(url: string): Promise<void> {
  // Dev automation only: hand the URL to a test driver instead of the user's browser.
  const devUrlFile = app.isPackaged
    ? ''
    : (process.env.ORCA_BILLING_DEV_OPEN_URL_FILE?.trim() ?? '')
  await (devUrlFile ? appendFile(devUrlFile, `${url}\n`, { mode: 0o600 }) : shell.openExternal(url))
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export async function startCloudSetup(
  userDataPath: string,
  args: CloudSetupStartArgs
): Promise<CloudSetupStartResult> {
  const device = setupDeviceLabel()
  const body = {
    ...(args.repo ? { repo: args.repo } : {}),
    needs: args.needs,
    device,
    useActiveTeam: !args.chooseTeam
  }
  const create = (): ReturnType<typeof withBillingToken<z.infer<typeof CreatedBody>>> =>
    withBillingToken(userDataPath, (token, endpoints) =>
      createSetupSessionRequest(endpoints, token, body)
    )
  try {
    const signedIn = await create()
    if (signedIn.status === 'ok') {
      await openInBrowser(signedIn.value.url)
      return { status: 'opened', sessionId: signedIn.value.id, expiresAt: signedIn.value.expiresAt }
    }
    if (signedIn.status === 'unconfigured') {
      return { status: 'unconfigured' }
    }
    // Signed out: one tab signs in and then carries on into setup.
    // Filled in by afterSignIn, inside the sign-in flow.
    const outcome: { created: z.infer<typeof CreatedBody> | null; error: unknown } = {
      created: null,
      error: null
    }
    const connected = await connectCurrentOrcaProfile(userDataPath, {
      authorizeParams: {
        setup: '1',
        device,
        // New users skip the team page (made for them), so only plan/GitHub are announced.
        setup_steps: args.needs.filter((need) => need !== 'team').join(',')
      },
      afterSignIn: async () => {
        try {
          const result = await create()
          outcome.created = result.status === 'ok' ? result.value : null
        } catch (error) {
          outcome.error = error
        }
        return outcome.created?.url ?? null
      }
    })
    if (connected.status === 'cancelled' || connected.status === 'timed-out') {
      return { status: 'cancelled' }
    }
    if (connected.status !== 'connected') {
      return connected.status === 'unconfigured'
        ? { status: 'unconfigured' }
        : { status: 'failed', error: connected.error }
    }
    const session = outcome.created
    if (!session) {
      return {
        status: 'failed',
        error: outcome.error ? message(outcome.error) : 'setup_session_unavailable'
      }
    }
    return { status: 'opened', sessionId: session.id, expiresAt: session.expiresAt }
  } catch (error) {
    return { status: 'failed', error: message(error) }
  }
}

export async function getCloudSetupSession(
  userDataPath: string,
  sessionId: string
): Promise<CloudSetupGetResult> {
  if (!CLOUD_SETUP_SESSION_ID.test(sessionId)) {
    return { status: 'not-found' }
  }
  try {
    const result = await withBillingToken(userDataPath, (token, endpoints) =>
      getSetupSessionRequest(endpoints, token, sessionId)
    )
    return result.status === 'ok' ? { status: 'ok', session: result.value } : result
  } catch (error) {
    if (error instanceof BillingServiceError && error.statusCode === 404) {
      return { status: 'not-found' }
    }
    return { status: 'failed', error: message(error) }
  }
}

const LinkBody = z.object({ url: z.string().url().startsWith('https://') })

/** "Copy setup link": a fresh one-time link to the same session, for a different browser. */
export async function getCloudSetupLink(
  userDataPath: string,
  sessionId: string
): Promise<CloudSetupLinkResult> {
  if (!CLOUD_SETUP_SESSION_ID.test(sessionId)) {
    return { status: 'not-found' }
  }
  try {
    const result = await withBillingToken(userDataPath, async (token, endpoints) => {
      const body = LinkBody.safeParse(
        await billingRequest(
          endpoints,
          token,
          'POST',
          `v1/cloud-setup/sessions/${sessionId}/link`,
          {},
          fetch
        )
      )
      if (!body.success) {
        throw new Error('invalid_setup_link')
      }
      return body.data.url
    })
    return result.status === 'ok' ? { status: 'ok', url: result.value } : result
  } catch (error) {
    if (error instanceof BillingServiceError && error.statusCode === 404) {
      return { status: 'not-found' }
    }
    return { status: 'failed', error: message(error) }
  }
}
