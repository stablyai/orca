// Apps Composio has no sign-in of its own for connect once the owner adds a developer app under
// Composio's Auth Configs; a session signs in through it only when told to.
import type { ComposioApp, ComposioAppPage } from '../../shared/composio/composio-apps'
import { ComposioNeedsOwnSignInError, type ComposioApi } from './composio-api'

/** Marks the apps the owner already set up in Auth Configs as ones Composio signs in to. */
async function withOwnerSetUp(api: ComposioApi, apps: ComposioApp[]): Promise<ComposioApp[]> {
  if (!apps.some((app) => app.signIn === 'own')) {
    return apps
  }
  // Without the list, they read as not set up yet, and the card's Check again asks once more.
  const setUp = await api.authConfigApps().catch(() => new Map<string, string>())
  return apps.map((app) =>
    app.signIn === 'own' && setUp.has(app.slug) ? { ...app, signIn: 'composio' } : app
  )
}

export async function appsWithOwnerSetUp(
  api: ComposioApi,
  options: { search?: string; cursor?: string }
): Promise<ComposioAppPage> {
  const page = await api.apps(options)
  return { ...page, apps: await withOwnerSetUp(api, page.apps) }
}

export async function appWithOwnerSetUp(api: ComposioApi, slug: string): Promise<ComposioApp> {
  const app = await api.app(slug)
  const [checked] = await withOwnerSetUp(api, [app])
  return checked ?? app
}

/** The sign-in link, pointing the session at the owner's auth config when Composio has none. */
export async function linkWithOwnerSetUp(
  api: ComposioApi,
  sessionId: string,
  app: string
): Promise<{ url: string; accountId: string }> {
  try {
    return await api.connectLink(sessionId, app)
  } catch (error) {
    const authConfigId =
      error instanceof ComposioNeedsOwnSignInError
        ? (await api.authConfigApps().catch(() => null))?.get(app)
        : undefined
    if (!authConfigId) {
      throw error
    }
    await api.useAuthConfig(sessionId, app, authConfigId)
    return api.connectLink(sessionId, app)
  }
}
