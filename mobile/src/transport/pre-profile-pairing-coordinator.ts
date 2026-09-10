import type { ConnectOptions } from './rpc-client'
import type { PairingCandidateClient } from './mobile-relay-physical-client'
import { createPairingStageReporter } from './pairing-stage'
import {
  defaultPreProfilePairingFlowDependencies,
  runPreProfilePairingFlow,
  type PreProfilePairingClientCommit,
  type PreProfilePairingFlowDependencies
} from './pre-profile-pairing-flow'
import type { PairingOffer, PairingStage } from './types'

export type { PreProfilePairingClientCommit } from './pre-profile-pairing-flow'

export type PreProfilePairingAttempt = {
  readonly result: Promise<{ hostId: string }>
  readonly timedOut: boolean
  dispose(): void
}

export function startPreProfilePairing(args: {
  offer: PairingOffer
  timeoutMs: number
  clientCommit: PreProfilePairingClientCommit
  connectOptions?: ConnectOptions
  onStageChange?: (stage: PairingStage) => void
  dependencies?: Partial<PreProfilePairingFlowDependencies>
}): PreProfilePairingAttempt {
  const dependencies = { ...defaultPreProfilePairingFlowDependencies, ...args.dependencies }
  const clients = new Set<PairingCandidateClient>()
  let disposed = false
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let rejectTimeout: (error: Error) => void = () => {}
  const stageReporter = createPairingStageReporter({
    onLog: args.connectOptions?.onLog,
    onStageChange: args.onStageChange,
    now: dependencies.now
  })

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    for (const client of clients) {
      client.close()
    }
    clients.clear()
  }

  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject
  })
  timer = setTimeout(() => {
    timedOut = true
    const error = stageReporter.fail(new PairingTimeoutError())
    dispose()
    rejectTimeout(error)
  }, args.timeoutMs)

  stageReporter.complete('bundle_readiness')
  const pairing = runPreProfilePairingFlow({
    offer: args.offer,
    clientCommit: args.clientCommit,
    connectOptions: args.connectOptions,
    dependencies,
    clients,
    stageReporter,
    isDisposed: () => disposed
  })
  const result = Promise.race([pairing, timeout])
    .catch((error: unknown) => {
      if (timedOut) {
        throw error
      }
      throw stageReporter.fail(error)
    })
    .finally(() => {
      dispose()
    })

  return {
    result,
    get timedOut() {
      return timedOut
    },
    dispose
  }
}

class PairingTimeoutError extends Error {
  readonly code = 'pairing_timeout'

  constructor() {
    super('mobile pairing timed out')
    this.name = 'PairingTimeoutError'
  }
}
