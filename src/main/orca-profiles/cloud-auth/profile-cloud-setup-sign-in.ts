import { appendFile } from 'node:fs/promises'
import { app, shell } from 'electron'
import type { OrcaCloudSetupSignIn } from './profile-cloud-sign-in-session-data'

// Orca Cloud additions to the browser (PKCE) sign-in: cloud setup's authorize parameters and
// same-tab continuation, signing in without opening the browser, and dev-automation overrides.

/** A sign-in the browser never answers ends after this, with "Sign-in didn’t finish. Try again." */
export const ORCA_CLOUD_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

/** Dev automation only (unpackaged): ORCA_CLOUD_SIGN_IN_TIMEOUT_MS shortens the wait for a test run. */
export function orcaCloudSignInTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = app.isPackaged
): number {
  const override = packaged ? Number.NaN : Number(env.ORCA_CLOUD_SIGN_IN_TIMEOUT_MS)
  return Number.isFinite(override) && override >= 1_000 ? override : ORCA_CLOUD_SIGN_IN_TIMEOUT_MS
}

export type OrcaCloudSignInPkceOptions = {
  /** Extra authorize parameters (cloud setup: setup=1, device, setup_steps). */
  authorizeParams?: Record<string, string>
  /**
   * `false` starts the same flow without opening the browser (the person
   * copied the link to paste into a private window). The listener and its timeout are unchanged,
   * so an unused link ends like an unanswered click.
   */
  openBrowser?: boolean
}

export function applySignInAuthorizeParams(
  authorizeUrl: URL,
  authorizeParams: Record<string, string> | undefined
): void {
  // A plain sign-in asks auth for its branded "Sign in to Orca" page; servers
  // that don't know the flag ignore it. Cloud setup passes its own parameters.
  for (const [key, value] of Object.entries(authorizeParams ?? { signin_page: '1' })) {
    authorizeUrl.searchParams.set(key, value)
  }
}

export function openOrcaCloudAuthorizeUrl(
  authorizeUrl: string,
  openBrowser: boolean | undefined
): Promise<void> {
  if (openBrowser === false) {
    return Promise.resolve()
  }
  // Dev automation only (unpackaged): hand the sign-in URL to a test driver instead of
  // opening the developer's own browser. Same pattern as ORCA_BILLING_DEV_OPEN_URL_FILE.
  const devUrlFile = app.isPackaged ? '' : (process.env.ORCA_CLOUD_DEV_OPEN_URL_FILE?.trim() ?? '')
  return devUrlFile
    ? appendFile(devUrlFile, `${authorizeUrl}\n`, { mode: 0o600 })
    : shell.openExternal(authorizeUrl)
}

/** `openBrowser: false` starts sign-in without opening the browser. */
export type ConnectCurrentArgs = { openBrowser?: boolean }

/** The renderer's connect args: only an explicit `openBrowser: false` suppresses the browser. */
export function connectCurrentArgsFromUnknown(args: unknown): ConnectCurrentArgs {
  const openBrowser =
    typeof args === 'object' && args !== null
      ? Object.getOwnPropertyDescriptor(args, 'openBrowser')?.value
      : undefined
  return openBrowser === false ? { openBrowser: false } : {}
}

/**
 * The PKCE options a sign-in passes: cloud setup's parameters, or a plain sign-in that
 * may skip the browser (setup asks for that on its own `connect` args).
 */
export function pkceSignInOptions(
  setup: ({ authorizeParams?: Record<string, string> } & ConnectCurrentArgs) | undefined
): { openBrowser: boolean; authorizeParams?: Record<string, string> } {
  return {
    openBrowser: setup?.openBrowser !== false,
    ...(setup?.authorizeParams ? { authorizeParams: setup.authorizeParams } : {})
  }
}

/** Cloud setup continues in the same tab when it has a next page to show. */
export async function continueCloudSetupInBrowser(
  setup: OrcaCloudSetupSignIn | ConnectCurrentArgs | undefined,
  browser: { redirect: (location: string) => void }
): Promise<void> {
  if (!setup || !('afterSignIn' in setup)) {
    return
  }
  const next = await setup.afterSignIn().catch(() => null)
  if (next) {
    browser.redirect(next)
  }
}
