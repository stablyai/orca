import type { RpcClient } from '../transport/rpc-client'
import type { GenerationLease, GenerationStore } from './generation-store'
import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'
import { DOCUMENT_LOAD_DEADLINE_MS, PAGE_READY_DEADLINE_MS } from './mobile-web-shell-runtime'
import {
  cachedGenerationOf,
  download,
  openCache,
  readManifest
} from './mobile-web-shell-session-effects'
import type {
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent
} from './mobile-web-shell-session-contract'

export async function runMobileWebShellSessionEffect(args: {
  readonly effect: MobileWebShellSessionEffect
  readonly store: GenerationStore
  readonly lease: GenerationLease | null
  readonly hostKey: string
  readonly hostId: string
  readonly client: RpcClient | null
  readonly flow: number
  readonly runtime: MobileWebShellRuntime
  readonly startedAt: number
  readonly downloads: Set<AbortController>
  readonly timers: Set<() => void>
  readonly send: (event: MobileWebShellSessionEvent) => void
  readonly isCurrentDocument: () => boolean
}): Promise<void> {
  const { effect, store, lease, hostKey, hostId, client, flow, runtime, send } = args
  switch (effect.kind) {
    case 'rollback-generation': {
      if (lease !== null && lease.generation.buildId === effect.buildId) {
        await store.rejectGeneration(lease).catch(() => undefined)
      }
      const generation = await openCache(store, hostKey)
      send({
        type: 'rollback-read',
        flow,
        generation: generation?.buildId === effect.buildId ? null : generation
      })
      return
    }
    case 'confirm-generation': {
      if (lease !== null) {
        await store.confirmGeneration(lease, args.isCurrentDocument).catch(() => undefined)
      }
      return
    }
    case 'record-update-failure':
      // The runner owns host/time; best-effort store failures must not affect the decision.
      await store.recordUpdateFailure({ ...effect.failure, hostId, at: runtime.now() })
      return
    case 'forget-update-failures':
      await store.forgetHostUpdateFailures(hostId)
      return
    case 'open-cache':
      send({ type: 'cache-read', flow, generation: await openCache(store, hostKey) })
      return
    case 'read-manifest':
      await readManifest(client, flow, send)
      return
    case 'download':
      await download({
        client,
        store,
        hostKey,
        flow,
        runtime,
        startedAt: args.startedAt,
        downloads: args.downloads,
        send
      })
      return
    case 'open-generation': {
      const lease = await store
        .acquireGeneration(hostKey, { buildId: effect.buildId })
        .catch(() => null)
      if (lease === null) {
        send({ type: 'generation-open-failed', flow })
        return
      }
      send({
        type: 'activated',
        lease,
        generation: cachedGenerationOf(lease.generation),
        flow,
        generationDirectory: effect.directory,
        sessionId: runtime.mintSessionId(),
        buildId: effect.buildId,
        totalBytes: effect.totalBytes,
        elapsedMs: runtime.now() - args.startedAt
      })
      return
    }
    case 'remount':
      send({ type: 'remounted', flow, sessionId: runtime.mintSessionId() })
      return
    case 'await-page-ready':
    case 'await-document-load': {
      const pageReady = effect.kind === 'await-page-ready'
      const cancel = runtime.setTimer(
        () => {
          args.timers.delete(cancel)
          send({ type: pageReady ? 'page-ready-deadline' : 'document-load-deadline', flow })
        },
        pageReady ? PAGE_READY_DEADLINE_MS : DOCUMENT_LOAD_DEADLINE_MS
      )
      args.timers.add(cancel)
    }
  }
}
