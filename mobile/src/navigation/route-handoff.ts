import { useRouter } from 'expo-router'

/** The router, as the worktree list holds it. Router-shaped so a caller substitutes nothing. */
export type RouteHandoff = ReturnType<typeof useRouter>

/**
 * Native: the router, and nothing between the screen and it.
 *
 * The web sibling is where this earns its name — inside the shell's page a screen is one document
 * among the phone's screens, and a route the page does not render has to be handed back to the app
 * that does. Here there is no page and no handing back.
 */
export function useRouteHandoff(): RouteHandoff {
  return useRouter()
}
