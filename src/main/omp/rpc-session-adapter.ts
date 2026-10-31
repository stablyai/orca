import { z } from 'zod'
import { PiRpcSessionAdapter, type PiRpcSessionAdapterDeps } from '../pi/rpc-session-adapter'
import type { PiRpcSession } from '../pi/rpc-session'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { applyPiRpcSessionOption } from '../pi/rpc-options'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { createOmpRpcDialogs } from './rpc-dialogs'
import { buildOmpRpcLaunch, ompRpcProviderLink } from './rpc-launch'
import { openOmpRpcConnection } from './rpc-connection'
import { goalSchema, reportGoal, receiveOmpFrame } from './rpc-session-events'
import { OmpRpcFastOptions } from './rpc-options'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { OmpRpcRewind, rewindOmpSession, supportsOmpRewind } from './rpc-rewind'
import { stopOmpSubagents, supportsOmpSubagentStop } from './rpc-subagent-stops'
import { importOmpSubagentHistory } from './rpc-subagent-history'

export class OmpRpcSessionAdapter extends PiRpcSessionAdapter {
  readonly atRestCommands: StructuredAgentSessionAdapter['atRestCommands']

  constructor(
    deps: PiRpcSessionAdapterDeps & Pick<StructuredAgentSessionAdapter, 'atRestCommands'>
  ) {
    const fastOptions = new WeakMap<PiRpcSession['connection'], OmpRpcFastOptions>()
    const rewindConnections = new WeakSet<PiRpcSession['connection']>()
    const rewinds = new WeakMap<PiRpcSession, OmpRpcRewind>()
    const subagentStops = new WeakSet<PiRpcSession['connection']>()
    super({
      ...deps,
      buildLaunch: buildOmpRpcLaunch,
      openConnection: (launch, handlers) => {
        const connection = (deps.openConnection ?? openOmpRpcConnection)(launch, handlers)
        const observed = new OmpRpcFastOptions()
        const rpc = { request: connection.request.bind(connection) }
        connection.request = (...args) => observed.request(rpc, ...args)
        fastOptions.set(connection, observed)
        return connection
      },
      dialect: {
        agent: 'omp',
        correlatedPrompts: true,
        idleAbort: true,
        prepare: async (connection) => {
          if (await supportsOmpSubagentStop(connection)) {
            subagentStops.add(connection)
          }
          await connection.request('set_subagent_subscription', { level: 'events' })
          if (await supportsOmpRewind(connection)) {
            rewindConnections.add(connection)
          }
        },
        dispatchOptions: {
          keys: ['model', 'effort', 'fastMode'],
          // Native commands can change Fast between messages without a config_update event.
          alwaysWrite: ['fastMode'],
          write: (session, key, value, signal) =>
            this.setOption({
              sessionId: session.input.identity.sessionId,
              fence: session.input.fence,
              key,
              value,
              signal
            })
        },
        providerLink: ompRpcProviderLink,
        dialogs: createOmpRpcDialogs,
        receive: (frame, session) => {
          let rewind = rewinds.get(session)
          if (!rewind) {
            rewind = new OmpRpcRewind((error) =>
              deps.logger.warn('OMP rewind marker failed', {
                scope: 'omp-rpc-rewind',
                sessionId: session.input.identity.sessionId,
                error
              })
            )
            rewinds.set(session, rewind)
          }
          rewind.receive(frame, session)
          return receiveOmpFrame(frame, session, deps.logger, () =>
            subagentStops.has(session.connection)
          )
        }
      }
    })
    this.atRestCommands = deps.atRestCommands
    this.backgroundTaskStops = (sessionId) => {
      const session = this.sessions.get(sessionId)
      return session && !session.connection.closed
        ? { supportsTaskStop: subagentStops.has(session.connection), supportsStopAll: false }
        : undefined
    }
    this.stopBackgroundTasks = (input) => {
      const session = this.session(input.sessionId, input.fence)
      if (!subagentStops.has(session.connection)) {
        throw new Error('This OMP version does not support native subagent cancellation')
      }
      return stopOmpSubagents(
        session,
        input,
        () => this.sessions.get(input.sessionId) === session && !session.connection.closed
      )
    }
    this.rewindSupport = (sessionId) => {
      const session = this.sessions.get(sessionId)
      return !session || rewindConnections.has(session.connection)
        ? { supported: true }
        : { supported: false, reason: 'unsupported' }
    }
    this.readOptions = async (input) => {
      const session = this.session(input.sessionId, input.fence)
      const options = await session.readOptions()
      return fastOptions.get(session.connection)?.read(options) ?? options
    }
    const parentOpen = this.open
    this.open = async (input) => {
      const result = await parentOpen(input)
      const session = this.session(input.sessionId, input.fence)
      if (session.sessionFile) {
        await importOmpSubagentHistory({
          parentSession: session.sessionFile,
          sink: session.input.events,
          signal: input.signal,
          logger: (message, error) =>
            this.deps.logger.warn(message, {
              scope: 'omp-subagent-history',
              sessionId: input.sessionId,
              error
            })
        })
      }
      return result
    }
  }

  rewindSupport: NonNullable<StructuredAgentSessionAdapter['rewindSupport']>
  backgroundTaskStops: NonNullable<StructuredAgentSessionAdapter['backgroundTaskStops']>
  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']>

  rewind: NonNullable<StructuredAgentSessionAdapter['rewind']> = (input) =>
    rewindOmpSession(this.session(input.sessionId, input.fence), input.beforeTurnId)

  recoverRewind: NonNullable<StructuredAgentSessionAdapter['recoverRewind']> = (input) =>
    rewindOmpSession(this.session(input.sessionId, input.fence), input.beforeTurnId, {
      recover: true,
      signal: input.signal
    })

  setOption: StructuredAgentSessionAdapter['setOption'] = async (input) => {
    const session = this.session(input.sessionId, input.fence)
    if (input.key === 'fastMode') {
      if (input.value !== 'true' && input.value !== 'false') {
        throw new Error('OMP Fast mode requires a boolean')
      }
      input.signal?.throwIfAborted()
      const token = { pending: true }
      session.optionProof.writes.set('fastMode', token)
      session.optionProof.current.delete('fastMode')
      try {
        await waitForPromiseWithSignal(
          session.connection.request('set_fast_mode', { enabled: input.value === 'true' }),
          input.signal
        )
        if (session.optionProof.writes.get('fastMode') !== token) {
          throw new Error('OMP Fast option write was superseded')
        }
        session.selected.set('fastMode', input.value)
        session.optionProof.current.set('fastMode', input.value)
        return Object.fromEntries(session.selected)
      } finally {
        if (session.optionProof.writes.get('fastMode') === token) {
          session.optionProof.writes.set('fastMode', { pending: false })
        }
      }
    }
    const result = await applyPiRpcSessionOption(
      session.connection,
      session.selected,
      input.key,
      input.value,
      { signal: input.signal },
      session.optionProof
    )
    await this.refreshOptionsAfterWrite(session)
    return result
  }

  private async refreshOptionsAfterWrite(session: PiRpcSession): Promise<void> {
    if (session.connection.closed) {
      return
    }
    await session.refreshOptions().catch((error: unknown) =>
      this.deps.logger.warn('OMP options could not be refreshed after a write', {
        scope: 'omp-rpc',
        sessionId: session.input.identity.sessionId,
        error
      })
    )
  }

  changeThreadGoal: NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']> = async (
    input
  ) => {
    const session = this.session(input.sessionId, input.fence)
    input.signal?.throwIfAborted()
    try {
      const current = z
        .object({ goal: goalSchema.nullable() })
        .parse(await session.connection.request('goal', { op: 'get' }))
      if (input.change.kind === 'set' && current.goal && current.goal.status !== 'dropped') {
        return {
          ok: false,
          rejected: 'OMP RPC cannot replace an existing Goal. Clear it before creating another.'
        }
      }
      for (const key of ['model', 'effort', 'fastMode'] as const) {
        const value = input.executionOptions?.[key]
        if (value !== undefined) {
          await this.setOption({
            sessionId: input.sessionId,
            fence: input.fence,
            key,
            value,
            signal: input.signal
          })
        }
      }
      const params =
        input.change.kind === 'set'
          ? { op: 'create', objective: input.change.objective }
          : input.change.kind === 'clear'
            ? { op: 'drop' }
            : { op: input.change.status === 'active' ? 'resume' : 'pause' }
      input.signal?.throwIfAborted()
      const answer = z
        .object({ goal: goalSchema.nullable() })
        .parse(await session.connection.request('goal', params))
      reportGoal(session, answer.goal)
      return { ok: true }
    } catch (error) {
      if (error instanceof JsonlRpcResponseError) {
        if (error.command === 'goal' && error.message === 'Unknown command: goal') {
          return {
            ok: false,
            rejected:
              'This OMP version does not expose native Goal over RPC. Update OMP to use Goal.'
          }
        }
        return { ok: false, rejected: error.message }
      }
      throw error
    }
  }
}
