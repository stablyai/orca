import { randomUUID } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type {
  AgentSessionOptionsResult,
  AgentSessionSlashCommand
} from '../../shared/agent-session-wire'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  unpickedSessionConfiguredChoice,
  type AgentModelCatalogConfiguredChoice
} from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { piRpcProviderLink, type PiRpcResolvedLaunch } from './rpc-launch-resolution'
import {
  applyPiRpcSessionOption,
  piModelOptionId,
  readPiRpcCommands,
  readPiRpcSessionOptions
} from './rpc-options'
import { piRpcStateSchema, type PiRpcState } from './rpc-protocol'
import type { PiRpcConnection, PiRpcSessionDeps } from './rpc-session'

export class PiRpcSessionStartup {
  started = false
  answered = false
  commands?: AgentSessionSlashCommand[]
  /** What the start listed; a signed-out Pi lists no model. */
  options?: AgentSessionOptionsResult
  /** What this child started on, as its config's default; never re-read, so a later switch (an
   *  extension's or the user's) teaches nothing. */
  startChoice?: AgentModelCatalogConfiguredChoice | null
  private readonly controller = new AbortController()

  constructor(
    private readonly input: StructuredAgentSessionAcquireInput,
    private readonly generation: string,
    private readonly connection: PiRpcConnection,
    private readonly selected: Map<string, string>,
    private readonly deps: PiRpcSessionDeps,
    /** A new Pi session starts on its config's model; a resumed or forked one keeps its own. */
    private readonly resolvesConfig: boolean,
    private readonly setState: (state: PiRpcState) => void
  ) {}

  stop(): void {
    this.controller.abort(new Error('Pi closed while starting'))
  }

  async run(launch: PiRpcResolvedLaunch): Promise<void> {
    const optionRevision = this.input.optionRevision?.() ?? 0
    const answer = await this.wait(this.connection.request('get_state'))
    this.answered = true
    this.assertLive()
    const state = piRpcStateSchema.parse(answer)
    const link = piRpcProviderLink(
      launch,
      state.sessionFile,
      this.input.fence,
      randomUUID(),
      Date.now()
    )
    this.setState(state)
    const current: AgentSessionOptionsResult['current'] = {
      model: state.model ? piModelOptionId(state.model.provider, state.model.id) : '',
      ...(state.thinkingLevel ? { effort: state.thinkingLevel } : {})
    }
    const saved = this.input.options ?? {}
    const skipped = Object.keys(saved).filter((key) => key !== 'model' && key !== 'effort')
    // Keys a restore sent, whether or not Pi took them.
    const picked = new Set<string>()
    for (const key of ['model', 'effort'] as const) {
      const value = saved[key]
      if (value === undefined) {
        continue
      }
      picked.add(key)
      try {
        this.assertLive()
        await this.wait(applyPiRpcSessionOption(this.connection, this.selected, key, value))
        current[key] = value
      } catch (error) {
        if (!(error instanceof JsonlRpcResponseError)) {
          throw error
        }
        skipped.push(key)
        this.warn('Pi rejected a saved option', 'pi-option-restore', error, { key })
      }
    }
    this.assertLive()
    current.confirmed = [...(current.model ? ['model'] : []), ...(current.effort ? ['effort'] : [])]
    // Part of the start, as other agents' handshakes answer with theirs: a Pi that lists no model
    // is signed out, and what it started on names its config's default.
    const options = await this.readListing()
    this.assertLive()
    if (options) {
      this.options = options
      this.startChoice = unpickedSessionConfiguredChoice({
        resolvesConfig: this.resolvesConfig,
        picked,
        ...options
      })
    }
    this.started = true
    this.deps.onLifecycle({
      type: 'started',
      ...this.identity(),
      link,
      reportedOptions: options?.current ?? current,
      restoreSkippedOptions: skipped,
      optionRevision
    })
    await this.readCommands()
  }

  /** Never fails the start: without it the chat only lacks the listing and the sign-in verdict. */
  private async readListing(): Promise<AgentSessionOptionsResult | undefined> {
    try {
      return await this.wait(readPiRpcSessionOptions(this.connection))
    } catch (error) {
      this.assertLive()
      this.warn('Pi options could not be read', 'pi-options', error)
      return undefined
    }
  }

  private async readCommands(): Promise<void> {
    try {
      this.assertLive()
      const result = await this.wait(readPiRpcCommands(this.connection))
      this.assertLive()
      this.commands = result.commands
    } catch (error) {
      this.warn('Pi commands could not be read', 'pi-commands', error)
    }
  }

  private assertLive(): void {
    if (this.controller.signal.aborted || this.connection.closed) {
      throw new Error('Pi closed while starting')
    }
  }

  private wait<T>(promise: Promise<T>): Promise<T> {
    return waitForPromiseWithSignal(promise, this.controller.signal)
  }

  private identity() {
    return {
      sessionId: this.input.identity.sessionId,
      fence: this.input.fence,
      acquisitionGeneration: this.generation
    }
  }

  private warn(message: string, scope: string, error: unknown, fields = {}): void {
    if (!this.controller.signal.aborted) {
      this.deps.logger.warn(message, {
        scope,
        sessionId: this.input.identity.sessionId,
        error,
        ...fields
      })
    }
  }
}
