import React from 'react'
import { useAllHostClients } from '../transport/client-context'
import { loadHosts } from '../transport/host-store'
import type { HostProfile } from '../transport/types'
import { loadSpeakReplies, saveSpeakReplies } from '../storage/speak-replies-preference'
import { useSessionSpeakBack } from './use-session-speak-back'

// Tier 1: speak-back follows the WORKSPACE you armed, not the screen you happen
// to be looking at.
//
// Why this provider exists: the watcher used to live inside the session screen,
// so navigating back to the host list unmounted it and replies went silent with
// no indication why. Arming a workspace is a statement about that workspace, not
// about the current route, so the timer belongs above the navigator.
//
// Still bounded by the app being foregrounded — Android throttles JS timers and
// drops audio focus in the background. Speaking with the app backgrounded is a
// separate problem that wants the notification channel, not a longer timer.

type SpeakBackContextValue = {
  /** Workspace keys (`hostId::worktreeId`) currently armed. */
  armed: ReadonlySet<string>
  isArmed: (hostId: string, worktreeId: string) => boolean
  setArmed: (hostId: string, worktreeId: string, enabled: boolean) => void
  /** True while any armed workspace is folding or speaking a reply. */
  busy: boolean
}

const SpeakBackContext = React.createContext<SpeakBackContextValue | null>(null)

export function speakBackKey(hostId: string, worktreeId: string): string {
  return `${hostId}::${worktreeId}`
}

function splitKey(key: string): { hostId: string; worktreeId: string } {
  const at = key.indexOf('::')
  return { hostId: key.slice(0, at), worktreeId: key.slice(at + 2) }
}

/** One armed workspace's watcher. A component per workspace keeps the hook rules
 *  intact — the alternative is a loop of hooks, which React forbids. */
function ArmedWorkspaceWatcher({
  hostId,
  worktreeId,
  hostEndpoint,
  onBusyChange
}: {
  hostId: string
  worktreeId: string
  hostEndpoint?: string | null
  onBusyChange: (key: string, busy: boolean) => void
}): null {
  const hostIds = React.useMemo(() => [hostId], [hostId])
  const clients = useAllHostClients(hostIds)
  const client = clients[0]?.client ?? null
  const { busy } = useSessionSpeakBack({ client, worktreeId, hostEndpoint, enabled: true })
  const key = speakBackKey(hostId, worktreeId)

  React.useEffect(() => {
    onBusyChange(key, busy)
  }, [key, busy, onBusyChange])

  // Why a cleanup that clears busy: an unarmed workspace must not leave a stale
  // "speaking" indicator behind on the toggle.
  React.useEffect(() => () => onBusyChange(key, false), [key, onBusyChange])

  return null
}

export function SpeakBackProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [armed, setArmedSet] = React.useState<ReadonlySet<string>>(() => new Set())
  const [busyKeys, setBusyKeys] = React.useState<ReadonlySet<string>>(() => new Set())
  // Why: per-host endpoint lookup is what lets the watcher route its
  // mesh-voice calls to the right Tailscale node. Re-fetched on demand when
  // the armed set grows so a host added since the last load still resolves.
  const hostEndpointByIdRef = React.useRef<Map<string, string>>(new Map())
  const ensureHostsLoaded = React.useCallback(async (): Promise<Map<string, string>> => {
    try {
      const hosts: HostProfile[] = await loadHosts()
      const next = new Map<string, string>()
      for (const h of hosts) {
        next.set(h.id, h.endpoint)
      }
      hostEndpointByIdRef.current = next
      return next
    } catch {
      return hostEndpointByIdRef.current
    }
  }, [])

  const onBusyChange = React.useCallback((key: string, busy: boolean) => {
    setBusyKeys((current) => {
      if (current.has(key) === busy) {
        return current
      }
      const next = new Set(current)
      if (busy) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
  }, [])

  const setArmed = React.useCallback((hostId: string, worktreeId: string, enabled: boolean) => {
    const key = speakBackKey(hostId, worktreeId)
    void saveSpeakReplies(hostId, worktreeId, enabled)
    if (!hostEndpointByIdRef.current.has(hostId)) {
      // Why: cheapest possible refresh — a new host that wasn't in the cache
      // yet triggers a single loadHosts() instead of a full re-fetch on every
      // arm event.
      void ensureHostsLoaded()
    }
    setArmedSet((current) => {
      if (current.has(key) === enabled) {
        return current
      }
      const next = new Set(current)
      if (enabled) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
  }, [ensureHostsLoaded])

  const isArmed = React.useCallback(
    (hostId: string, worktreeId: string) => armed.has(speakBackKey(hostId, worktreeId)),
    [armed]
  )

  const value = React.useMemo<SpeakBackContextValue>(
    () => ({ armed, isArmed, setArmed, busy: busyKeys.size > 0 }),
    [armed, isArmed, setArmed, busyKeys]
  )

  return (
    <SpeakBackContext.Provider value={value}>
      {[...armed].map((key) => {
        const { hostId, worktreeId } = splitKey(key)
        return (
          <ArmedWorkspaceWatcher
            key={key}
            hostId={hostId}
            worktreeId={worktreeId}
            hostEndpoint={hostEndpointByIdRef.current.get(hostId) ?? null}
            onBusyChange={onBusyChange}
          />
        )
      })}
      {children}
    </SpeakBackContext.Provider>
  )
}

/**
 * Bind one workspace's toggle to the app-level armed set, restoring its stored
 * value on first mount. Safe to call when the provider is absent (it degrades to
 * a no-op) so screens rendered outside the tree in tests do not explode.
 */
export function useSpeakRepliesToggle(
  hostId: string,
  worktreeId: string
): { enabled: boolean; busy: boolean; toggle: () => void } {
  const ctx = React.useContext(SpeakBackContext)
  const enabled = ctx?.isArmed(hostId, worktreeId) ?? false

  // Why restore here rather than in the provider: the provider has no idea which
  // workspaces exist until a screen names one, and AsyncStorage has no listing
  // we would want to trust for auto-arming everything on launch.
  React.useEffect(() => {
    if (!ctx) {
      return
    }
    let cancelled = false
    void loadSpeakReplies(hostId, worktreeId).then((stored) => {
      if (!cancelled && stored && !ctx.isArmed(hostId, worktreeId)) {
        ctx.setArmed(hostId, worktreeId, true)
      }
    })
    return () => {
      cancelled = true
    }
    // Why not depend on ctx: its identity changes whenever any workspace's busy
    // state flips, which would re-run this restore constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, worktreeId])

  const toggle = React.useCallback(() => {
    ctx?.setArmed(hostId, worktreeId, !enabled)
  }, [ctx, hostId, worktreeId, enabled])

  return { enabled, busy: ctx?.busy ?? false, toggle }
}
