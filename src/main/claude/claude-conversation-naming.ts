import { activeProviderContext } from '../../shared/agent-session-provider-context'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { claudeSessionIdForOrcaSession } from './structured/claude-structured-session-id'
import {
  createClaudeNamingGeneration,
  type ClaudeNamingGeneration
} from './claude-naming-generation'
import type { ClaudeNamingInputs } from './claude-naming-invocation'
import { renameClaudeTranscript } from './claude-provider-session-rename'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

type Intent = {
  record: AgentSessionRecord
  name: string
  sequence: number
  inheritance?: boolean
  inputs: Promise<ClaudeNamingInputs>
}
type Operation = {
  latest: Intent
  generations: Set<ClaudeNamingGeneration>
  listeners: Set<() => void>
  done: Promise<void>
}

export function claudeNamingContextId(record: AgentSessionRecord): string {
  const active = activeProviderContext(record)
  return (
    active.head?.handle.nativeId ??
    claudeSessionIdForOrcaSession(
      record.sessionId,
      active.pendingClear ? record.providerContextBoundary?.operationId : undefined
    )
  )
}

function matches(generation: ClaudeNamingGeneration, record: AgentSessionRecord): boolean {
  return (
    generation.chat === record.sessionId &&
    generation.boundary === record.providerContextBoundary?.operationId &&
    generation.nativeId === claudeNamingContextId(record)
  )
}

function sameLaunch(a: ClaudeNamingInputs, b: ClaudeNamingInputs): boolean {
  return a.home === b.home && a.cwd === b.cwd && a.command === b.command
}

/** Each accepted occurrence owns only its chat/context's finite overlapping acquisition. */
export class ClaudeConversationNaming {
  private readonly generations = new Map<string, Set<ClaudeNamingGeneration>>()
  private readonly operations = new Map<string, Operation>()
  private readonly chatOperations = new Map<string, Set<Operation>>()
  private readonly tails = new Map<string, Promise<void>>()
  private stopped = false

  constructor(
    private readonly deps: {
      snapshot(record: AgentSessionRecord): Promise<ClaudeNamingInputs>
      timeoutMs?: number
    }
  ) {}

  acquire(
    input: StructuredAgentSessionAcquireInput,
    record: AgentSessionRecord | null | undefined
  ): ClaudeNamingGeneration {
    const chat = input.identity.sessionId
    const nativeId = record
      ? claudeNamingContextId(record)
      : (input.identity.providerHandle?.nativeId ?? claudeSessionIdForOrcaSession(chat))
    const registry = this.generations.get(chat) ?? new Set<ClaudeNamingGeneration>()
    this.generations.set(chat, registry)
    const generation = createClaudeNamingGeneration(
      chat,
      record?.providerContextBoundary?.operationId,
      nativeId,
      () => {
        for (const operation of this.chatOperations.get(chat) ?? []) {
          if (matches(generation, operation.latest.record)) {
            operation.generations.add(generation)
          }
        }
        if (generation.phase === 'exited') {
          registry.delete(generation)
          if (!registry.size && this.generations.get(chat) === registry) {
            this.generations.delete(chat)
          }
        }
      }
    )
    registry.add(generation)
    for (const operation of this.chatOperations.get(chat) ?? []) {
      if (matches(generation, operation.latest.record)) {
        operation.generations.add(generation)
      }
    }
    return generation
  }

  stop(): void {
    this.stopped = true
    for (const operation of this.operations.values()) {
      for (const listener of operation.listeners) {
        listener()
      }
    }
  }

  accept(input: Omit<Intent, 'inputs'>): Promise<void> {
    if (this.stopped) {
      return Promise.resolve()
    }
    const chat = input.record.sessionId
    const key = JSON.stringify([
      chat,
      input.record.providerContextBoundary?.operationId,
      claudeNamingContextId(input.record)
    ])
    const generations = new Set(
      [...(this.generations.get(chat) ?? [])].filter((generation) =>
        matches(generation, input.record)
      )
    )
    const owned = [...generations].find(
      (generation) => generation.inputs && generation.phase !== 'exited'
    )
    const inputs = owned?.inputs ? Promise.resolve(owned.inputs) : this.deps.snapshot(input.record)
    // Capture immediately even while an earlier issued occurrence is being joined.
    void inputs.catch(() => {})
    const intent = { ...input, inputs }
    const current = this.operations.get(key)
    if (current) {
      current.latest = intent
      for (const listener of current.listeners) {
        listener()
      }
      return current.done
    }
    const operation: Operation = {
      latest: intent,
      generations,
      listeners: new Set(),
      done: Promise.resolve()
    }
    this.operations.set(key, operation)
    const chatOperations = this.chatOperations.get(chat) ?? new Set<Operation>()
    chatOperations.add(operation)
    this.chatOperations.set(chat, chatOperations)
    const previous = this.tails.get(chat) ?? Promise.resolve()
    const done = previous.catch(() => {}).then(() => this.deliver(key, operation))
    operation.done = done
    this.tails.set(chat, done)
    void done
      .finally(() => {
        if (this.tails.get(chat) === done) {
          this.tails.delete(chat)
        }
      })
      .catch(() => {})
    return done
  }

  private ready(
    generation: ClaudeNamingGeneration,
    operation: Operation,
    intent: Intent
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const settle = (ready: boolean) => {
        unsubscribe()
        operation.listeners.delete(inspect)
        resolve(ready)
      }
      const inspect = () => {
        if (this.stopped || operation.latest !== intent) {
          settle(false)
        } else if (generation.phase === 'ready') {
          settle(true)
        } else if (generation.phase !== 'acquiring' && generation.phase !== 'initializing') {
          settle(false)
        }
      }
      const unsubscribe = generation.subscribe(inspect)
      operation.listeners.add(inspect)
      inspect()
    })
  }

  private async deliver(key: string, operation: Operation): Promise<void> {
    try {
      for (;;) {
        const intent = operation.latest
        try {
          const inputs = await intent.inputs
          if (operation.latest !== intent) {
            continue
          }
          const delivered = new Set<ClaudeNamingGeneration>()
          const applicable = (generation: ClaudeNamingGeneration) =>
            matches(generation, intent.record) &&
            generation.inputs !== undefined &&
            sameLaunch(generation.inputs, inputs)
          let error: unknown
          if (!intent.inheritance || operation.generations.size === 0) {
            // Only join a close already issued by the ordinary lifecycle; never initiate Stop here.
            for (const generation of operation.generations) {
              if (applicable(generation) && generation.closing) {
                await generation.closing
                if (generation.connection?.exitVerdict.root !== 'exited') {
                  throw new Error('Claude naming cannot use an unproven transcript writer')
                }
                delivered.add(generation)
              }
            }
            const owner = [...operation.generations].find(
              (generation) => applicable(generation) && generation.phase === 'ready'
            )
            try {
              if (owner) {
                delivered.add(owner)
                await this.rename(owner, intent.name)
              } else {
                if (
                  [...operation.generations].some(
                    (generation) => applicable(generation) && generation.phase === 'unproven'
                  )
                ) {
                  throw new Error('Claude naming cannot use an unproven transcript writer')
                }
                await renameClaudeTranscript(
                  inputs.home,
                  claudeNamingContextId(intent.record),
                  intent.name
                )
              }
            } catch (cause) {
              error = cause
            }
          }
          // Set iteration includes registrations made during real I/O and each awaited readiness.
          for (const generation of operation.generations) {
            try {
              if (operation.latest !== intent) {
                break
              }
              if (!matches(generation, intent.record) || delivered.has(generation)) {
                continue
              }
              if (this.stopped || !(await this.ready(generation, operation, intent))) {
                error ??= new Error(
                  'Claude naming follow-up ended before its acquisition became ready'
                )
                continue
              }
              if (this.stopped || !applicable(generation)) {
                continue
              }
              await this.rename(generation, intent.name)
              delivered.add(generation)
              error = undefined
            } finally {
              if (applicable(generation) && generation.closing) {
                await generation.closing
              }
            }
          }
          if (operation.latest !== intent) {
            continue
          }
          if (error) {
            throw error
          }
          // No await between the last registration/sequence check and retiring the occurrence.
          return
        } catch (error) {
          if (operation.latest === intent) {
            throw error
          }
        }
      }
    } finally {
      this.operations.delete(key)
      const chat = operation.latest.record.sessionId
      const operations = this.chatOperations.get(chat)
      operations?.delete(operation)
      if (!operations?.size) {
        this.chatOperations.delete(chat)
      }
      operation.generations.clear()
      operation.listeners.clear()
    }
  }

  private rename(generation: ClaudeNamingGeneration, name: string): Promise<void> {
    if (!generation.connection || generation.phase !== 'ready') {
      return Promise.reject(new Error('Claude naming owner retired before its control was issued'))
    }
    return generation.connection.renameSession(
      name,
      generation.nativeId,
      this.deps.timeoutMs === undefined ? undefined : { timeoutMs: this.deps.timeoutMs }
    )
  }
}
