import { useRouter } from 'expo-router'

export type RouteHandoff = ReturnType<typeof useRouter>

// Native routes use Expo directly; the web sibling hands targets outside the page back to the shell.
export function useRouteHandoff(): RouteHandoff {
  return useRouter()
}

// Null without a shell. `returns` says whether the shell goes back to a session's existing entry instead of pushing a second one.
export type ShellSessionHandoff = Readonly<{
  returns: () => boolean
  open: (href: string) => void
}> | null

export function useShellSessionHandoff(): ShellSessionHandoff {
  return null
}
