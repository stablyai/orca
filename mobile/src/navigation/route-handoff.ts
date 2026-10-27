import { useRouter } from 'expo-router'

export type RouteHandoff = ReturnType<typeof useRouter>

// Native routes use Expo directly; the web sibling hands targets outside the page back to the shell.
export function useRouteHandoff(): RouteHandoff {
  return useRouter()
}
