import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { KeybindingContext } from '../../../src/shared/keybindings'

type ContextRegistration = {
  context: KeybindingContext
  owner: symbol
}

const registrations = new Map<string, ContextRegistration[]>()
const listeners = new Set<() => void>()

export function usePublishMobileSessionHardwareKeyboardContext(options: {
  context: KeybindingContext
  hostId: string | undefined
  worktreeId: string | undefined
}): void {
  const { context, hostId, worktreeId } = options
  useEffect(() => {
    if (!hostId || !worktreeId) {
      return
    }
    const key = routeKey(hostId, worktreeId)
    const registration = { context, owner: Symbol(key) }
    registrations.set(key, [...(registrations.get(key) ?? []), registration])
    emitChange()
    return () => {
      const remaining = (registrations.get(key) ?? []).filter(
        (candidate) => candidate.owner !== registration.owner
      )
      if (remaining.length > 0) {
        registrations.set(key, remaining)
      } else {
        registrations.delete(key)
      }
      emitChange()
    }
  }, [context, hostId, worktreeId])
}

export function useMobileSessionHardwareKeyboardContext(
  hostId: string | undefined,
  worktreeId: string | undefined
): KeybindingContext {
  const getSnapshot = useCallback(() => getRouteContext(hostId, worktreeId), [hostId, worktreeId])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function getRouteContext(
  hostId: string | undefined,
  worktreeId: string | undefined
): KeybindingContext {
  if (!hostId || !worktreeId) {
    return 'app'
  }
  return registrations.get(routeKey(hostId, worktreeId))?.at(-1)?.context ?? 'app'
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitChange(): void {
  listeners.forEach((listener) => listener())
}

function routeKey(hostId: string, worktreeId: string): string {
  return `${hostId}\0${worktreeId}`
}
