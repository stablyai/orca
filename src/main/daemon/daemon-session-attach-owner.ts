import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import type { RouteObservation } from './daemon-session-route-authority'

function assertClientConnected(signal: PtySpawnOptions['signal']): void {
  if (signal?.aborted) {
    throw new Error('client_disconnected')
  }
}

export async function attachSessionToOwner<T extends IPtyProvider>(
  resolver: DaemonSessionOwnerResolver<T>,
  providers: readonly T[],
  routes: Map<string, IPtyProvider>,
  opts: PtySpawnOptions & { sessionId: string },
  admission?: RouteObservation
): Promise<PtySpawnResult> {
  assertClientConnected(opts.signal)
  const routed = providers.find((provider) => provider === routes.get(opts.sessionId))
  const direct = routed ?? (providers.length === 1 ? providers[0] : undefined)
  const routedIncarnation = resolver.authority.incarnation(opts.sessionId)
  const routeNeedsAuthoritativeResolution =
    direct &&
    routed &&
    opts.expectedIncarnationIsAuthoritative === true &&
    routedIncarnation !== opts.expectedIncarnationId
  if (direct && !routeNeedsAuthoritativeResolution) {
    const directObservation = admission ?? resolver.authority.capture()
    try {
      const result = await direct.spawn(opts)
      if (
        !result.exitedBeforeSpawnReply &&
        result.id === opts.sessionId &&
        result.isReattach === true
      ) {
        await resolver.publishSpawnResult(result, direct, directObservation)
      }
      return result
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) {
        throw error
      }
      if (providers.length === 1) {
        throw error
      }
      if (routed && routes.get(opts.sessionId) === routed) {
        resolver.forgetRoute(opts.sessionId, routed, directObservation)
      }
    }
  }

  assertClientConnected(opts.signal)
  const resolution = await resolver.resolve(
    opts.sessionId,
    opts.expectedIncarnationId,
    opts.expectedIncarnationIsAuthoritative,
    admission
  )
  assertClientConnected(opts.signal)
  if (resolution.kind === 'unknown') {
    throw new TerminalSessionOwnerUnverifiedError(opts.sessionId)
  }
  if (resolution.kind === 'absent') {
    throw new SessionNotFoundError(opts.sessionId)
  }
  const resolvedObservation = admission ?? resolver.authority.capture()
  try {
    const result = await resolution.provider.spawn(opts)
    if (
      !result.exitedBeforeSpawnReply &&
      result.id === opts.sessionId &&
      result.isReattach === true
    ) {
      await resolver.publishSpawnResult(result, resolution.provider, resolvedObservation)
    }
    return result
  } catch (error) {
    if (error instanceof SessionNotFoundError && providers.length > 1) {
      throw new TerminalSessionOwnerUnverifiedError(opts.sessionId)
    }
    throw error
  }
}
