import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ExpoCrypto from 'expo-crypto'
import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import { useHostProtocolGates } from '../components/HostProtocolGate'
import { useHostClient } from '../transport/client-context'
import { encodeBase64Url } from '../transport/mobile-endpoint-supervisor-support'
import { fetchMobileWebBundle } from '../transport/mobile-web-bundle-fetch'
import {
  isMobileWebBundleTransportFailure,
  mobileWebBundleManifestRead
} from '../transport/mobile-web-bundle-operations'
import { runRpcOperation } from '../transport/rpc-operation'
import type { RpcClient } from '../transport/rpc-client'
import { createGenerationStore, type GenerationStore } from './generation-store'
import {
  createExpoGenerationFileSystem,
  generationDirectoryPath
} from './generation-store-file-system'
import { deriveHostCacheKey } from './host-cache-key'
import {
  createMobileWebShellSession,
  readMobileWebShellReachability,
  reduceMobileWebShellSession
} from './mobile-web-shell-session'
import type {
  MobileWebShellReadFailure,
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent,
  MobileWebShellSessionState
} from './mobile-web-shell-session-contract'

/** 32 bytes, base64url: the session id scopes the view's private origin, so two mounts must never
 *  share one and a remount must never reuse the one that was just on screen. */
const SESSION_ID_BYTES = 32

/** The impure edges, injectable so the wiring is testable without a simulator. */
export type MobileWebShellRuntime = {
  createStore(): GenerationStore
  mintSessionId(): string
  now(): number
}

function defaultRuntime(): MobileWebShellRuntime {
  return {
    createStore: () => createGenerationStore({ fileSystem: createExpoGenerationFileSystem() }),
    mintSessionId: () => encodeBase64Url(ExpoCrypto.getRandomBytes(SESSION_ID_BYTES)),
    now: Date.now
  }
}

export type MobileWebShellSessionView = {
  readonly state: MobileWebShellSessionState
  readonly retry: () => void
  /** B3's failure reasons, forwarded verbatim; the reducer owns what each one means. */
  readonly reportShellFailure: (reason: MobileWebShellFailureReason) => void
}

/**
 * Drives one hybrid shell session for one host: the reducer decides, this runs what it asks for.
 *
 * Every effect result is checked against an epoch before it is dispatched, so an unmount, a host
 * change or a retry abandons work in flight instead of applying it to the next session. Nothing
 * here decides anything — a rule that lived in this file would be a rule with no table test.
 */
export function useMobileWebShellSession(args: {
  hostId: string
  runtime?: MobileWebShellRuntime
}): MobileWebShellSessionView {
  const { hostId } = args
  const gates = useHostProtocolGates()
  const { client, state: connState } = useHostClient(hostId)

  const runtimeRef = useRef<MobileWebShellRuntime | null>(null)
  runtimeRef.current ??= args.runtime ?? defaultRuntime()
  const runtime = runtimeRef.current
  const storeRef = useRef<GenerationStore | null>(null)
  storeRef.current ??= runtime.createStore()

  const sessionRef = useRef(createMobileWebShellSession())
  const [state, setState] = useState(sessionRef.current.state)
  const hostKey = useMemo(() => deriveHostCacheKey(hostId), [hostId])
  const startedAtRef = useRef(runtime.now())
  // Bumped by anything that invalidates work in flight; every dispatch out of an effect checks it.
  const epochRef = useRef(0)
  // Aborted on the same bump: a download nobody will use still holds four of the host's read slots.
  const downloadsRef = useRef<Set<AbortController>>(new Set())
  const runEffectRef = useRef<
    ((epoch: number, flow: number, effect: MobileWebShellSessionEffect) => void) | null
  >(null)

  const dispatch = useCallback((epoch: number, event: MobileWebShellSessionEvent): void => {
    if (epoch !== epochRef.current) {
      return
    }
    const stepped = reduceMobileWebShellSession(sessionRef.current, event)
    sessionRef.current = stepped.session
    setState(stepped.session.state)
    for (const effect of stepped.effects) {
      // Every effect of a step belongs to the flow that step produced, and its result carries that
      // number back, so a flow the session has since restarted reports into nothing.
      runEffectRef.current?.(epoch, stepped.session.flow, effect)
    }
  }, [])

  const invalidate = useCallback((): void => {
    epochRef.current += 1
    for (const controller of downloadsRef.current) {
      controller.abort()
    }
    downloadsRef.current.clear()
  }, [])

  const runEffect = useCallback(
    async (epoch: number, flow: number, effect: MobileWebShellSessionEffect): Promise<void> => {
      const store = storeRef.current
      if (store === null) {
        return
      }
      const send = (event: MobileWebShellSessionEvent) => dispatch(epoch, event)
      switch (effect.kind) {
        case 'delete-cache':
          // Reports nothing: the store serialises its own queue, so the sweep and read the reducer
          // queued behind this one already run after it.
          await store.deleteHostCache(hostKey).catch(() => undefined)
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
            startedAt: startedAtRef.current,
            downloads: downloadsRef.current,
            send
          })
          return
        case 'open-generation':
          send({
            type: 'activated',
            flow,
            generationDirectory: effect.directory,
            sessionId: runtime.mintSessionId(),
            buildId: effect.buildId,
            totalBytes: effect.totalBytes,
            elapsedMs: runtime.now() - startedAtRef.current
          })
          return
        case 'remount':
          send({ type: 'remounted', flow, sessionId: runtime.mintSessionId() })
          return
      }
    },
    [client, dispatch, hostKey, runtime]
  )
  // Written after the commit, never during render: React may replay or discard a render, and a
  // closure from one that never committed would run effects for a session that never existed.
  // Declared above every effect that dispatches, so the first one already finds it.
  useEffect(() => {
    runEffectRef.current = (epoch, flow, effect) => {
      void runEffect(epoch, flow, effect)
    }
  }, [runEffect])

  useEffect(() => {
    // A new host is a new session: the old one's latches, cache handle and in-flight work all go.
    invalidate()
    sessionRef.current = createMobileWebShellSession()
    startedAtRef.current = runtime.now()
    setState(sessionRef.current.state)
    return invalidate
  }, [hostId, invalidate, runtime])

  const { statusPending, statusReadable, hostCapabilities, hostProtocolWindow } = gates
  const reachability = readMobileWebShellReachability(connState, client)
  useEffect(() => {
    dispatch(epochRef.current, {
      type: 'gates-changed',
      gates: {
        statusPending,
        statusReadable,
        reachability,
        hostCapabilities,
        hostStatus: hostProtocolWindow
      }
    })
    // `hostId` is in the list for the host whose gates read identically to the last one's: the
    // reducer now starts nothing on a repeat verdict, so a session that never re-armed would sit
    // in `checking` forever.
  }, [
    dispatch,
    hostCapabilities,
    hostId,
    hostProtocolWindow,
    reachability,
    statusPending,
    statusReadable
  ])

  const retry = useCallback(() => {
    // A fresh epoch first: a failed download still in flight must not land on the retried session.
    invalidate()
    startedAtRef.current = runtime.now()
    dispatch(epochRef.current, { type: 'retry-pressed' })
  }, [dispatch, invalidate, runtime])

  const reportShellFailure = useCallback(
    (reason: MobileWebShellFailureReason) => {
      dispatch(epochRef.current, { type: 'shell-failed', reason })
    },
    [dispatch]
  )

  return { state, retry, reportShellFailure }
}

async function openCache(
  store: GenerationStore,
  hostKey: string
): Promise<{ buildId: string; directory: string; totalBytes: number } | null> {
  try {
    // Here and nowhere earlier: with the flag off no code path reaches this hook, so a store build
    // never sweeps a cache it never wrote.
    await store.sweepStagedGenerations()
    const active = await store.readActiveGeneration(hostKey)
    return active === null
      ? null
      : {
          buildId: active.buildId,
          directory: generationDirectoryPath(active.directory),
          totalBytes: active.manifest.totalBytes
        }
  } catch {
    // A cache that cannot be read is not a cache that is wrong: nothing is deleted, and the flow
    // treats it as absent, which downloads when connected and says so when not.
    return null
  }
}

/** A rejection the link caused says nothing about the bundle, and the reducer opens the cache on it
 *  rather than telling a phone that already holds a workspace it could not be downloaded. */
function readFailure(error: unknown): MobileWebShellReadFailure {
  return isMobileWebBundleTransportFailure(error) ? 'transport' : 'bundle'
}

async function readManifest(
  client: RpcClient | null,
  flow: number,
  send: (event: MobileWebShellSessionEvent) => void
): Promise<void> {
  if (client === null) {
    // No client is no link, and the gates are about to say so.
    send({ type: 'download-failed', flow, failure: 'transport' })
    return
  }
  try {
    const opened = await runRpcOperation(client, mobileWebBundleManifestRead, null)
    const manifest = opened.manifest
    send({
      type: 'manifest-read',
      flow,
      manifest: {
        buildId: manifest.buildId,
        schemaVersion: manifest.schemaVersion,
        runtimeProtocolVersion: manifest.runtimeProtocolVersion,
        minCompatibleRuntimeProtocolVersion: manifest.minCompatibleRuntimeProtocolVersion,
        totalBytes: manifest.totalBytes,
        totalAssets: manifest.assets.length
      }
    })
  } catch (error) {
    send({ type: 'download-failed', flow, failure: readFailure(error) })
  }
}

async function download(args: {
  client: RpcClient | null
  store: GenerationStore
  hostKey: string
  flow: number
  runtime: MobileWebShellRuntime
  startedAt: number
  downloads: Set<AbortController>
  send: (event: MobileWebShellSessionEvent) => void
}): Promise<void> {
  const { client, store, hostKey, flow, runtime, send } = args
  if (client === null) {
    send({ type: 'download-failed', flow, failure: 'transport' })
    return
  }
  const controller = new AbortController()
  args.downloads.add(controller)
  try {
    const fetched = await fetchMobileWebBundle({
      client,
      signal: controller.signal,
      onProgress: (progress) => send({ type: 'fetch-progress', flow, ...progress })
    })
    // The bytes are in; the session they were for may not be. The fetch throws on an abort it sees,
    // but an abort landing between its last read and this line would otherwise still write a
    // generation for a host screen nobody is on any more.
    if (controller.signal.aborted) {
      return
    }
    send({ type: 'download-staged', flow })
    const staged = await store.stageGeneration(hostKey, fetched)
    // Again before the commit, because the commit is the write that is not the staging tree's to
    // undo: it renames into the active slot and moves the host index. An abort that landed while
    // the bytes were being staged takes the staged tree back out instead.
    if (controller.signal.aborted) {
      await store.abortStagedGeneration(staged).catch(() => undefined)
      return
    }
    const committed = await store.commitGeneration(staged)
    send({
      type: 'activated',
      flow,
      generationDirectory: generationDirectoryPath(committed.directory),
      sessionId: runtime.mintSessionId(),
      buildId: committed.buildId,
      totalBytes: committed.manifest.totalBytes,
      elapsedMs: runtime.now() - args.startedAt
    })
  } catch (error) {
    send({ type: 'download-failed', flow, failure: readFailure(error) })
  } finally {
    args.downloads.delete(controller)
  }
}
