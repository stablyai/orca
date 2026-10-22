import { randomUUID } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import type {
  AgentSessionOptionsResult,
  AgentSessionSlashCommand
} from '../../shared/agent-session-wire'
import {
  AgentSessionAcquisitionRefusal,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import {
  unpickedSessionConfiguredChoice,
  withLiveCatalogListing
} from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { piRpcProviderLink, type PiRpcResolvedLaunch } from './rpc-launch-resolution'
import { piModelOptionId, readPiRpcCommands, readPiRpcSessionOptions } from './rpc-options'
import { piRpcStateSchema, type PiRpcState } from './rpc-protocol'
import type { PiRpcConnection, PiRpcSessionDeps } from './rpc-session'
import { catchUpPiSession } from './rpc-history-catch-up'
import type { PiHistoryAnchor } from './rpc-history-capture'
import { decodePiHistoryClaim, encodePiHistoryClaim } from './rpc-history-journal-view'

export class PiRpcSessionStartup {
  commands?: AgentSessionSlashCommand[]
  /** Set by an open that left its claim at Pi's current leaf. */
  historyAnchor?: PiHistoryAnchor

  constructor(
    private readonly input: StructuredAgentSessionAcquireInput,
    private readonly connection: PiRpcConnection,
    private readonly deps: PiRpcSessionDeps,
    /** A new Pi session starts on its config's model; a resumed or forked one keeps its own. */
    private readonly resolvesConfig: boolean,
    private readonly setState: (state: PiRpcState) => void,
    private readonly failedCause: () => Error | undefined
  ) {}

  /** Ready once Pi reports its state: only an unknown provider fails the start. */
  async run(
    launch: PiRpcResolvedLaunch,
    signal: AbortSignal
  ): Promise<StructuredAgentSessionProviderOpenResult> {
    const answer = await this.wait(this.connection.request('get_state', {}), signal)
    this.assertLive(signal)
    const state = piRpcStateSchema.parse(answer)
    if (state.model?.provider === 'unknown') {
      throw this.notSignedIn()
    }
    const link = piRpcProviderLink(
      launch,
      state.sessionFile,
      this.input.fence,
      randomUUID(),
      Date.now()
    )
    this.setState(state)
    // Only the conversation this open continues can carry the claim; a replacement starts over.
    const continued = launch.sessionFile !== undefined || launch.forkFile !== undefined
    const history = await this.wait(
      catchUpPiSession({
        connection: this.connection,
        sessionId: this.input.identity.sessionId,
        sessionFile: state.sessionFile,
        lineage: new Set([...(launch.lineage ?? []), state.sessionFile]),
        claim: continued ? decodePiHistoryClaim(launch.previous?.handle.resumeCursor) : null,
        sink: this.input.events,
        signal,
        assertCurrent: () => this.assertLive(signal),
        logger: this.deps.logger
      }),
      signal
    )
    this.assertLive(signal)
    if (history.current) {
      this.historyAnchor = { entry: history.claim?.entry ?? null }
    }
    const current: AgentSessionOptionsResult['current'] = {
      model: state.model ? piModelOptionId(state.model.provider, state.model.id) : '',
      ...(state.thinkingLevel ? { effort: state.thinkingLevel } : {})
    }
    this.assertLive(signal)
    current.confirmed = [...(current.model ? ['model'] : []), ...(current.effort ? ['effort'] : [])]
    const claimed = history.claim
      ? { ...link, handle: { ...link.handle, resumeCursor: encodePiHistoryClaim(history.claim) } }
      : link
    return { link: claimed, reportedOptions: current }
  }

  /** After the open: the listing and the `/` commands reach the host as later reports, and a read
   *  that fails only leaves the chat without them. */
  async readAfterOpen(
    generation: string,
    opening: AgentSessionOptionsResult['current']
  ): Promise<void> {
    const options = await this.readListing()
    if (options && !this.failedCause() && !this.connection.closed) {
      // What it started on names its config's default once; a later switch teaches nothing.
      const { catalogListing } = withLiveCatalogListing(
        options,
        unpickedSessionConfiguredChoice({
          resolvesConfig: this.resolvesConfig,
          picked: new Set(Object.keys(this.input.options ?? {})),
          models: options.models,
          current: opening
        })
      )
      this.deps.onLifecycle({
        type: 'options-reported',
        sessionId: this.input.identity.sessionId,
        fence: this.input.fence,
        acquisitionGeneration: generation,
        reportedOptions: options.current,
        ...(catalogListing ? { catalogListing } : {})
      })
    }
    await this.readCommands()
  }

  private async readListing(): Promise<AgentSessionOptionsResult | undefined> {
    try {
      return await readPiRpcSessionOptions(this.connection)
    } catch (error) {
      this.warn('Pi options could not be read', 'pi-options', error)
      return undefined
    }
  }

  private async readCommands(): Promise<void> {
    try {
      const result = await readPiRpcCommands(this.connection)
      if (this.failedCause() || this.connection.closed) {
        return
      }
      this.commands = result.commands
      this.input.events?.publish()
    } catch (error) {
      this.warn('Pi commands could not be read', 'pi-commands', error)
    }
  }

  private assertLive(signal: AbortSignal): void {
    const failure = this.failedCause()
    if (failure) {
      throw failure
    }
    if (signal.aborted || this.connection.closed) {
      throw new Error('Pi closed while starting')
    }
  }

  private wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return waitForPromiseWithSignal(promise, signal)
  }

  private notSignedIn(): AgentSessionAcquisitionRefusal {
    return withProviderDiagnostic(
      new AgentSessionAcquisitionRefusal(
        'Pi has no authenticated model provider available.',
        'notSignedIn'
      ),
      providerDiagnostic('Pi has no authenticated model provider available.', 'person')
    )
  }

  private warn(message: string, scope: string, error: unknown, fields = {}): void {
    this.deps.logger.warn(message, {
      scope,
      sessionId: this.input.identity.sessionId,
      error,
      ...fields
    })
  }
}
