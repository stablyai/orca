import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/pty-provider-contract'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

function assertClientConnected(signal: PtySpawnOptions['signal']): void {
  if (signal?.aborted) {
    throw new Error('client_disconnected')
  }
}

export async function spawnDaemonAttachOnly<T extends IPtyProvider>(
  opts: PtySpawnOptions & { sessionId: string },
  providers: readonly T[],
  routes: ReadonlyMap<string, IPtyProvider>,
  routeIncarnations: ReadonlyMap<string, string | undefined>,
  resolver: Pick<DaemonSessionOwnerResolver<T>, 'resolve' | 'recordRoute' | 'forgetRoute'>
): Promise<PtySpawnResult> {
  assertClientConnected(opts.signal)
  const routed = providers.find((provider) => provider === routes.get(opts.sessionId))
  const direct = routed ?? (providers.length === 1 ? providers[0] : undefined)
  const routedIncarnation = routeIncarnations.get(opts.sessionId)
  const routeNeedsAuthoritativeResolution =
    direct &&
    routed &&
    opts.expectedIncarnationIsAuthoritative === true &&
    routedIncarnation !== opts.expectedIncarnationId
  if (direct && !routeNeedsAuthoritativeResolution) {
    try {
      const result = await direct.spawn(opts)
      if (
        !result.exitedBeforeSpawnReply &&
        result.id === opts.sessionId &&
        result.isReattach === true
      ) {
        resolver.recordRoute(result.id, direct, result.incarnationId)
      }
      return result
    } catch (error) {
      if (!(error instanceof SessionNotFoundError) || providers.length === 1) {
        throw error
      }
      if (routed && routes.get(opts.sessionId) === routed) {
        resolver.forgetRoute(opts.sessionId, routed)
      }
    }
  }

  assertClientConnected(opts.signal)
  const resolution = await resolver.resolve(
    opts.sessionId,
    opts.expectedIncarnationId,
    opts.expectedIncarnationIsAuthoritative
  )
  assertClientConnected(opts.signal)
  if (resolution.kind === 'unknown') {
    throw new TerminalSessionOwnerUnverifiedError(opts.sessionId)
  }
  if (resolution.kind === 'absent') {
    throw new SessionNotFoundError(opts.sessionId)
  }
  try {
    const result = await resolution.provider.spawn(opts)
    if (
      !result.exitedBeforeSpawnReply &&
      result.id === opts.sessionId &&
      result.isReattach === true
    ) {
      resolver.recordRoute(result.id, resolution.provider, result.incarnationId)
    }
    return result
  } catch (error) {
    if (error instanceof SessionNotFoundError && providers.length > 1) {
      throw new TerminalSessionOwnerUnverifiedError(opts.sessionId)
    }
    throw error
  }
}
