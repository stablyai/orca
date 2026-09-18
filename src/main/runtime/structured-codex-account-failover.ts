import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { CodexAccountService } from '../codex-accounts/service'
import type { CodexStructuredSessionAdapterDeps } from '../codex/codex-structured-session-state'
import { resolvePinnedCodexRolloutProof } from '../codex/codex-tui-rollout-proof'
import { tryHardlinkCodexSessionFile } from '../codex/codex-session-link'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

export class StructuredCodexAccountFailover {
  private readonly continuations = new Map<string, string>()
  private readonly automaticOperations = new Set<string>()

  async dispatched(sessionId: string, operationId: string): Promise<void> {
    if (this.automaticOperations.has(operationId)) {
      return
    }
    this.continuations.delete(sessionId)
    const record = this.deps.store.getRecord(sessionId)
    if (record?.codexFailoverHomes?.length) {
      await this.deps.store.transitionHandoff(sessionId, (current) => ({
        ...current,
        codexFailoverHomes: []
      }))
    }
  }

  constructor(
    private readonly deps: {
      store: Pick<AgentSessionRecordStore, 'getRecord' | 'transitionHandoff'>
      accounts: () =>
        | (Pick<CodexAccountService, 'failover'> & {
            automation: Pick<CodexAccountService['automation'], 'reportFailure'>
          })
        | undefined
      seamless: () => boolean
      host: () => Pick<StructuredAgentSessionHost, 'send'> | null
    }
  ) {}

  failover: NonNullable<CodexStructuredSessionAdapterDeps['failover']> = async (input) => {
    const accounts = this.deps.accounts()
    if (!accounts) {
      return false
    }
    if (input.historyMode === 'paginated') {
      accounts.automation.reportFailure(
        'This Codex conversation uses database history. Automatic account migration is unavailable; its work has been left intact.'
      )
      return false
    }
    const source = await resolvePinnedCodexRolloutProof(input.home, input.threadId)
    const relative = source && relativePathInsideRoot(join(input.home, 'sessions'), source)
    if (!source || !relative || !input.isSafe()) {
      return false
    }
    return accounts
      .failover({
        home: input.home,
        signal: input.signal,
        isSafe: input.isSafe,
        excludedHomes: this.deps.store.getRecord(input.sessionId)?.codexFailoverHomes,
        migrate: async (account, isCurrent) => {
          const record = this.deps.store.getRecord(input.sessionId)
          if (
            !record ||
            record.lease.runtimeFence !== input.fence ||
            record.accountHome.path !== input.home ||
            record.codexFailoverHomes?.includes(account.managedHomePath)
          ) {
            throw new Error('Account switch superseded')
          }
          const destination = join(account.managedHomePath, 'sessions', relative)
          await mkdir(dirname(destination), { recursive: true })
          if (!input.isSafe()) {
            throw new Error('Account switch superseded')
          }
          const existing = await resolvePinnedCodexRolloutProof(
            account.managedHomePath,
            input.threadId
          )
          if (existing) {
            const [sourceStat, existingStat] = await Promise.all([stat(source), stat(existing)])
            if (
              !sourceStat.ino ||
              sourceStat.ino !== existingStat.ino ||
              sourceStat.dev !== existingStat.dev
            ) {
              throw new Error('Conversation history has a different writer')
            }
          } else if (!tryHardlinkCodexSessionFile(source, destination)) {
            throw new Error('Conversation history could not be retained')
          }
          if (!isCurrent() || !input.isSafe()) {
            throw new Error('Account switch superseded')
          }
          if (!(await input.stop())) {
            throw new Error('Provider exit is unverifiable')
          }
          if (!isCurrent()) {
            throw new Error('Account switch superseded')
          }
          await this.deps.store.transitionHandoff(input.sessionId, (current) => {
            if (
              !isCurrent() ||
              current.lease.runtimeFence !== input.fence ||
              current.accountHome.path !== input.home
            ) {
              throw new Error('Account switch superseded')
            }
            return {
              ...current,
              accountHome: { ...current.accountHome, path: account.managedHomePath },
              codexFailoverHomes: [
                ...new Set([
                  ...(current.codexFailoverHomes ?? []),
                  input.home,
                  account.managedHomePath
                ])
              ],
              updatedAt: Date.now()
            }
          })
          if (this.deps.seamless()) {
            this.continuations.set(
              input.sessionId,
              createStructuredAgentSessionOperationId(randomUUID, Date.now())
            )
          }
        }
      })
      .catch((error: unknown) => {
        this.continuations.delete(input.sessionId)
        accounts.automation.reportFailure(
          'Automatic account recovery paused. Review the conversation and account selection before continuing.'
        )
        throw error
      })
  }

  async recovered(sessionId: string): Promise<void> {
    const operationId = this.continuations.get(sessionId)
    const host = this.deps.host()
    const record = this.deps.store.getRecord(sessionId)
    if (!operationId || !host || !record || !this.deps.seamless()) {
      return
    }
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'Continue from the interrupted turn. Preserve completed work and do not repeat completed tool actions.'
        }
      ]
    }
    // The host ledger persists admission before dispatch; an ambiguous send is never retried here.
    this.automaticOperations.add(operationId)
    try {
      const result = await host.send(
        { callerKey: 'trusted-local:codex-account-failover' },
        {
          beforeRun: () => {
            if (this.continuations.get(sessionId) !== operationId || !this.deps.seamless()) {
              throw new Error('Automatic continuation superseded')
            }
          },
          body,
          envelope: {
            sessionId,
            clientOperationId: operationId,
            expectedRuntimeFence: record.lease.runtimeFence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.send',
              sessionId,
              fields: { body }
            })
          }
        }
      )
      if (!result.ok || result.value.submission.dispatchState !== 'accepted') {
        this.deps
          .accounts()
          ?.automation.reportFailure(
            'Account switched, but continuation was not confirmed. Review the conversation before continuing.'
          )
      }
    } catch {
      this.deps
        .accounts()
        ?.automation.reportFailure(
          'Account switched, but continuation was not confirmed. Review the conversation before continuing.'
        )
    } finally {
      this.automaticOperations.delete(operationId)
      this.continuations.delete(sessionId)
    }
  }
}
