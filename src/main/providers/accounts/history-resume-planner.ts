import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import type {
  HistoryContinuation,
  HistoryResumeAccount,
  HistoryResumePlan
} from '../../../shared/ai-vault/resume/history-resume-accounts'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import {
  verifiedWorkspaceConversation,
  assertWorkspaceConversationScope
} from './workspace-conversation-source'
import type { HistoryContinuationLedger } from './history-continuation-ledger'
import { forkHistoryConversation } from './history-conversation-fork'
import { healPendingCodexAccountThreads } from '../../codex/history/index/codex-account-session-index-heal'
import { parseCodexRolloutThreadId } from '../../codex/history/rollouts/codex-rollout-thread-id'

type Provider = 'codex' | 'claude'
type Source = Awaited<ReturnType<typeof verifiedWorkspaceConversation>>
type Pending = {
  args: AiVaultPrepareSessionResumeArgs
  source: Source
  sessionId: string
  rootSessionId: string
  lastAccountId?: string | null
  plan: HistoryResumePlan
  expires: number
}
export type HistoryResumePlannerDeps = {
  ledger: HistoryContinuationLedger
  roots(provider: Provider): Promise<readonly string[]>
  workspacePath(id: string): string | undefined
  accounts(
    provider: Provider,
    workspaceId: string
  ): { accounts: HistoryResumeAccount[]; workspaceAccountId?: string | null }
  prepareAccount(provider: Provider, accountId: string | null): Promise<string>
  fork?: typeof forkHistoryConversation
  heal?: typeof healPendingCodexAccountThreads
}

export class HistoryResumePlanner {
  private readonly plans = new Map<string, Pending>()
  private readonly receipts = new Map<string, { entries: HistoryContinuation[]; expires: number }>()
  constructor(private readonly deps: HistoryResumePlannerDeps) {}
  async accountForSession(
    provider: Provider,
    sessionId: string
  ): Promise<{ accountId: string | null; home: string } | null> {
    this.prune()
    const pending = [...this.receipts.values()]
      .flatMap((receipt) => receipt.entries)
      .findLast(
        (entry) =>
          entry.provider === provider &&
          entry.sessionId === sessionId &&
          entry.accountId !== undefined
      )
    const entry =
      pending ??
      (await this.deps.ledger.list()).find(
        (row) => row.provider === provider && row.sessionId === sessionId
      )
    if (!entry || entry.accountId === undefined) {
      return null
    }
    if (
      !this.deps
        .accounts(provider, '')
        .accounts.some((account) => account.id === entry.accountId && account.available)
    ) {
      throw new Error(
        'The conversation account is unavailable. Sign in or choose another account in History.'
      )
    }
    return {
      accountId: entry.accountId,
      home: await this.deps.prepareAccount(provider, entry.accountId)
    }
  }

  async prepare(args: AiVaultPrepareSessionResumeArgs): Promise<AiVaultPrepareSessionResumeResult> {
    this.prune()
    if (args.historyCatalog) {
      return { useRealCodexHome: false, continuationCatalog: await this.deps.ledger.list() }
    }
    if (args.commitToken) {
      const receipt = this.receipts.get(args.commitToken)
      if (!receipt) {
        throw new Error('The resume receipt expired. Refresh History.')
      }
      const openedAt = Date.now()
      for (const entry of receipt.entries) {
        await this.deps.ledger.record({ ...entry, openedAt: entry.openedAt ? openedAt : 0 })
      }
      this.receipts.delete(args.commitToken)
      return { useRealCodexHome: false }
    }
    if (
      (args.agent !== 'codex' && args.agent !== 'claude') ||
      !args.workspaceId ||
      !args.sessionId
    ) {
      throw new Error('The session workspace is unavailable.')
    }
    if (args.preview || !args.planToken) {
      return this.preview(args)
    }
    const pending = this.plans.get(args.planToken)
    if (
      !pending ||
      pending.args.workspaceId !== args.workspaceId ||
      pending.args.filePath !== args.filePath ||
      pending.args.agent !== args.agent
    ) {
      throw new Error('The resume choice expired. Try again.')
    }
    const selectedId = args.resumeAccountId
    if (selectedId === undefined) {
      throw new Error('Choose an account before continuing.')
    }
    const current = this.deps.accounts(args.agent, args.workspaceId)
    if (!current.accounts.some((account) => account.id === selectedId && account.available)) {
      throw new Error('This account is unavailable. Sign in or choose another account.')
    }
    if (
      current.accounts.find((account) => account.id === selectedId)?.label !==
      pending.plan.accounts.find((account) => account.id === selectedId)?.label
    ) {
      throw new Error('The account changed while choosing. Try Resume again.')
    }
    this.plans.delete(args.planToken)
    const source = await verifiedWorkspaceConversation({
      provider: args.agent,
      filePath: pending.source.filePath,
      sessionId: pending.sessionId,
      roots: await this.deps.roots(args.agent)
    })
    const targetHome = await realpath(await this.deps.prepareAccount(args.agent, selectedId))
    const different =
      (pending.lastAccountId !== undefined && pending.lastAccountId !== selectedId) ||
      normalizeRuntimePathForComparison(source.sourceHome) !==
        normalizeRuntimePathForComparison(targetHome)
    let copy = { sessionId: pending.sessionId, filePath: source.filePath }
    if (different) {
      const workspace = this.deps.workspacePath(args.workspaceId)
      if (!workspace) {
        throw new Error('The session workspace is unavailable.')
      }
      await assertWorkspaceConversationScope(source.cwd, workspace)
      copy = await (this.deps.fork ?? forkHistoryConversation)({
        provider: args.agent,
        ...source,
        sessionId: pending.sessionId,
        targetHome,
        historyRoots: await this.deps.roots(args.agent)
      })
      if (args.agent === 'codex') {
        const rollout = parseCodexRolloutThreadId(copy.filePath)
        if (!rollout) {
          throw new Error('The continuation has no valid rollout identity.')
        }
        const result = await (this.deps.heal ?? healPendingCodexAccountThreads)(
          targetHome,
          new Map([[copy.sessionId, rollout.rolloutStamp]]),
          { retryFailed: true }
        )
        if (
          result.failedThreads ||
          result.missingThreads ||
          !['completed', 'up-to-date'].includes(result.outcome)
        ) {
          throw new Error(
            'The continuation could not be indexed. The original session was preserved.'
          )
        }
      }
    }
    const receipt = randomUUID()
    const openedAt = Date.now()
    const parent: HistoryContinuation = {
      provider: args.agent,
      sessionId: pending.sessionId,
      filePath: source.filePath,
      home: source.sourceHome,
      rootSessionId: pending.rootSessionId,
      accountId: pending.lastAccountId,
      openedAt: 0
    }
    const entry: HistoryContinuation = {
      provider: args.agent,
      ...copy,
      home: different ? targetHome : source.sourceHome,
      rootSessionId: pending.rootSessionId,
      ...(different ? { parentSessionId: pending.sessionId } : {}),
      accountId: selectedId,
      openedAt
    }
    this.receipts.set(receipt, {
      entries: different ? [parent, entry] : [entry],
      expires: openedAt + 1_800_000
    })
    if (different) {
      await this.deps.ledger.record(parent)
      await this.deps.ledger.record({ ...entry, accountId: undefined, openedAt: 0 })
    }
    return {
      useRealCodexHome: false,
      workspaceAccountPrepared: true,
      substituteSessionId: copy.sessionId,
      substituteTranscriptPath: copy.filePath,
      resumeReceipt: receipt,
      ...(args.agent === 'codex'
        ? { substituteCodexHome: different ? targetHome : source.sourceHome }
        : { substituteClaudeConfigDir: different ? targetHome : source.sourceHome })
    }
  }

  private async preview(
    args: AiVaultPrepareSessionResumeArgs
  ): Promise<AiVaultPrepareSessionResumeResult> {
    if (
      (args.agent !== 'codex' && args.agent !== 'claude') ||
      !args.sessionId ||
      !args.workspaceId
    ) {
      throw new Error('Invalid resume request.')
    }
    const entries = await this.deps.ledger.list()
    const recorded = entries.find(
      (entry) => entry.provider === args.agent && entry.sessionId === args.sessionId
    )
    const rootSessionId = recorded?.rootSessionId ?? args.sessionId
    const last = args.exactVersion
      ? recorded
      : entries
          .filter(
            (entry) =>
              entry.provider === args.agent &&
              entry.rootSessionId === rootSessionId &&
              entry.openedAt > 0
          )
          .sort((a, b) => b.openedAt - a.openedAt)[0]
    const sessionId = last?.sessionId ?? args.sessionId
    const source = await verifiedWorkspaceConversation({
      provider: args.agent,
      filePath: last?.filePath ?? args.filePath,
      sessionId,
      roots: await this.deps.roots(args.agent)
    })
    const { accounts, workspaceAccountId } = this.deps.accounts(args.agent, args.workspaceId)
    const lastAccountId = last?.accountId
    const plan: HistoryResumePlan = {
      token: randomUUID(),
      accounts,
      lastAccountId,
      workspaceAccountId,
      needsChoice:
        lastAccountId === undefined ||
        (workspaceAccountId !== undefined && workspaceAccountId !== lastAccountId) ||
        !accounts.some((account) => account.id === lastAccountId && account.available)
    }
    this.plans.set(plan.token, {
      args,
      source,
      sessionId,
      rootSessionId,
      lastAccountId,
      plan,
      expires: Date.now() + 300_000
    })
    return { useRealCodexHome: false, resumePlan: plan }
  }

  private prune(): void {
    for (const [key, value] of this.plans) {
      if (value.expires < Date.now()) {
        this.plans.delete(key)
      }
    }
    for (const [key, value] of this.receipts) {
      if (value.expires < Date.now()) {
        this.receipts.delete(key)
      }
    }
  }
}
