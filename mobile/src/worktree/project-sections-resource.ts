import type { RpcClient } from '../transport/types'
import {
  projectSectionsRead,
  readServedProjectSections,
  type ServedProjectSections
} from './project-sections-operations'

type CatalogAnswer = { kind: 'pending' } | { kind: 'answered'; value: ServedProjectSections | null }
export type ProjectSectionsAppState = {
  addEventListener: (type: 'change', listener: (state: string) => void) => { remove: () => void }
}
const resources = new WeakMap<RpcClient, ReturnType<typeof createProjectSectionsResource>>()

export function getProjectSectionsResource(client: RpcClient) {
  let resource = resources.get(client)
  if (!resource) {
    resource = createProjectSectionsResource(client)
    resources.set(client, resource)
  }
  return resource
}

function createProjectSectionsResource(client: RpcClient) {
  let answer: CatalogAnswer = { kind: 'pending' }
  let answerKey: string | undefined
  let fetchedAt = 0
  let epoch = 0
  let generation = client.getGeneration?.()
  let dirty = false
  let inFlight: Promise<void> | null = null
  const listeners = new Set<() => void>()
  let dispose: (() => void) | undefined

  const refresh = (force = true): Promise<void> => {
    if (!listeners.size) {
      return Promise.resolve()
    }
    if (inFlight) {
      if (force) {
        dirty = true
      }
      return inFlight
    }
    if (client.getState() !== 'connected') {
      return Promise.resolve()
    }
    if (!force && fetchedAt && Date.now() - fetchedAt < 60_000) {
      return Promise.resolve()
    }
    const attempt = epoch
    const transport = client.getGeneration?.()
    dirty = false
    // The transport's finite request deadline settles even after the final lease is released.
    inFlight = Promise.resolve()
      .then(() =>
        listeners.size && attempt === epoch
          ? projectSectionsRead.request(client, undefined, {
              timeoutMs: 30_000,
              budgetSpansConnect: true,
              failWhenDisconnected: true
            })
          : null
      )
      .then((reply) => {
        if (!listeners.size || attempt !== epoch || transport !== client.getGeneration?.()) {
          return
        }
        const result = readServedProjectSections(reply)
        if (result.kind !== 'answered') {
          return
        }
        fetchedAt = Date.now()
        const key = JSON.stringify(result.value)
        if (answer.kind === 'answered' && key === answerKey) {
          return
        }
        answerKey = key
        answer = result
        for (const listener of listeners) {
          listener()
        }
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = null
        if (listeners.size && dirty) {
          return refresh()
        }
        return undefined
      })
    return inFlight
  }

  const wake = () => {
    const current = client.getGeneration?.()
    if (generation !== current) {
      generation = current
      epoch++
    }
    void refresh()
  }
  const subscribe = (listener: () => void, appState: ProjectSectionsAppState): (() => void) => {
    listeners.add(listener)
    if (listeners.size === 1) {
      epoch++
      generation = client.getGeneration?.()
      // Subscribe before reading: ready/replay closes the publication/subscription race.
      const stopState = client.onStateChange((state) => {
        epoch++
        if (state === 'connected') {
          wake()
        }
      })
      const foreground = appState.addEventListener('change', (state) => {
        if (state === 'active') {
          wake()
        }
      })
      const stopEvents = client.subscribe('runtime.clientEvents.subscribe', null, (event) => {
        if (
          event &&
          typeof event === 'object' &&
          'type' in event &&
          (event.type === 'ready' ||
            event.type === 'reposChanged' ||
            event.type === 'sshStateChanged')
        ) {
          wake()
        }
      })
      dispose = () => {
        stopState()
        stopEvents()
        foreground.remove()
      }
      wake()
    }
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        epoch++
        dirty = false
        dispose?.()
        dispose = undefined
      }
    }
  }
  return { getSnapshot: () => answer, subscribe, refresh }
}
