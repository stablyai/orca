import type { HistoryResumePlannerDeps, Pending, Provider } from './history-resume-plan-types'
export type { HistoryResumePlannerDeps } from './history-resume-plan-types'
import { previewHistoryResume } from './history-resume-preview'
import { prepareHistoryConversation } from './history-continuation-preparation'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import type { HistoryContinuation } from '../../../shared/ai-vault/resume/history-resume-accounts'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import {
  verifiedWorkspaceConversation,
  assertWorkspaceConversationScope
} from './workspace-conversation-source'

export class HistoryResumePlanner {
  private readonly plans = new Map<string, Pending>()
  private readonly receipts = new Map<
    string,
    {
      entries: HistoryContinuation[]
      expires: number
      workspaceId?: string
      confirmedAccountLabel?: string
      confirmedAccountIdentity?: string
    }
  >()
  constructor(private readonly deps: HistoryResumePlannerDeps) {}

  async accountForReceipt(token: string, provider: Provider, workspaceId?: string) {
    this.prune()
    const receipt = this.receipts.get(token)
    const retained = receipt ? undefined : await this.deps.ledger.launchReceipts.get(token)
    const entry =
      retained?.entry ??
      receipt?.entries.findLast((entry) => entry.provider === provider && entry.openedAt > 0)
    if (
      (retained?.workspaceId ?? receipt?.workspaceId) !== workspaceId ||
      !entry ||
      entry.provider !== provider ||
      entry.accountId === undefined
    ) {
      throw new Error(
        'The History account choice expired or belongs to another workspace. Resume again from History.'
      )
    }
    if (
      retained &&
      (retained.entry.preparedAt ?? retained.entry.openedAt) + 1_800_000 <= Date.now()
    ) {
      throw new Error('The History account choice expired. Resume again from History.')
    }
    const confirmedLabel = retained?.entry.confirmedAccountLabel ?? receipt?.confirmedAccountLabel
    const confirmedIdentity =
      retained?.entry.confirmedAccountIdentity ?? receipt?.confirmedAccountIdentity
    const currentAccount = this.deps
      .accounts(provider, workspaceId ?? '')
      .accounts.find((account) => account.id === entry.accountId)
    if (
      (confirmedLabel !== undefined && currentAccount?.label !== confirmedLabel) ||
      (confirmedIdentity !== undefined && currentAccount?.identity !== confirmedIdentity)
    ) {
      throw new Error('The chosen account changed. Resume again from History to confirm it.')
    }
    if (
      !this.deps
        .accounts(provider, workspaceId ?? '')
        .accounts.some((account) => account.id === entry.accountId && account.available)
    ) {
      throw new Error(
        'The chosen History account is unavailable. Sign in or choose another account.'
      )
    }
    const home = await realpath(await this.deps.prepareAccount(provider, entry.accountId))
    const confirmedAgain = this.deps
      .accounts(provider, workspaceId ?? '')
      .accounts.find((account) => account.id === entry.accountId)
    if (
      !confirmedAgain?.available ||
      (confirmedLabel !== undefined && confirmedAgain.label !== confirmedLabel) ||
      (confirmedIdentity !== undefined && confirmedAgain.identity !== confirmedIdentity)
    ) {
      throw new Error('The chosen account changed. Resume again from History to confirm it.')
    }
    if (normalizeRuntimePathForComparison(home) !== normalizeRuntimePathForComparison(entry.home)) {
      throw new Error('The chosen History account home changed. Resume again from History.')
    }
    return { accountId: entry.accountId, home }
  }
  async prepare(args: AiVaultPrepareSessionResumeArgs): Promise<AiVaultPrepareSessionResumeResult> {
    this.prune()
    if (args.historyCatalog) {
      return { useRealCodexHome: false, continuationCatalog: await this.deps.ledger.list() }
    }
    if (args.commitToken) {
      const receipt = this.receipts.get(args.commitToken)
      if (!receipt) {
        const retained = await this.deps.ledger.launchReceipts.get(args.commitToken)
        if (retained) {
          const current = (await this.deps.ledger.list()).find(
            (entry) =>
              entry.provider === retained.entry.provider &&
              entry.filePath === retained.entry.filePath
          )
          if (
            retained.entry.committedAt !== undefined &&
            current &&
            current.openedAt >= retained.entry.committedAt
          ) {
            return { useRealCodexHome: false }
          }
          const preparedAt = retained.entry.preparedAt ?? retained.entry.openedAt
          if (preparedAt + 1_800_000 > Date.now()) {
            const openedAt = await this.deps.ledger.launchReceipts.setCommitTimestamp(
              args.commitToken,
              args.commitTimestamp ?? Date.now()
            )
            if (!openedAt) {
              throw new Error('The resume receipt expired. Refresh History.')
            }
            await this.deps.ledger.record({ ...retained.entry, openedAt })
            return { useRealCodexHome: false }
          }
        }
        throw new Error('The resume receipt expired. Refresh History.')
      }
      const openedAt =
        (await this.deps.ledger.launchReceipts.setCommitTimestamp(
          args.commitToken,
          args.commitTimestamp ?? Date.now()
        )) ??
        args.commitTimestamp ??
        Date.now()
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
    const selected = current.accounts.find((account) => account.id === selectedId)
    if (!selected?.available) {
      throw new Error('This account is unavailable. Sign in or choose another account.')
    }
    const previewed = pending.plan.accounts.find((account) => account.id === selectedId)
    if (selected.label !== previewed?.label || selected.identity !== previewed?.identity) {
      throw new Error('The account changed while choosing. Try Resume again.')
    }
    if (pending.preparing) {
      throw new Error('This resume choice is already being prepared.')
    }
    pending.preparing = true
    try {
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
        copy = await prepareHistoryConversation(
          this.deps,
          pending,
          source,
          args.agent,
          selectedId,
          targetHome
        )
      }

      const receipt = randomUUID()
      const confirmedAccountLabel = selected.label
      const confirmedAccountIdentity = selected.identity
      const parent: HistoryContinuation = {
        provider: args.agent,
        sessionId: pending.sessionId,
        filePath: source.filePath,
        home: source.sourceHome,
        rootSessionId: pending.rootSessionId,
        rootTranscriptKey: pending.rootTranscriptKey,
        accountId: pending.lastAccountId,
        openedAt: 0
      }
      const entry: HistoryContinuation = {
        provider: args.agent,
        ...copy,
        home: different ? targetHome : source.sourceHome,
        rootSessionId: pending.rootSessionId,
        rootTranscriptKey: pending.rootTranscriptKey,
        ...(different ? { parentSessionId: pending.sessionId } : {}),
        accountId: selectedId,
        openedAt: 1
      }
      const stagedReceipt = {
        workspaceId: args.workspaceId,
        entries: different ? [parent, entry] : [entry],
        expires: Date.now() + 1_800_000,
        confirmedAccountLabel,
        confirmedAccountIdentity
      }
      if (different) {
        await this.deps.ledger.record(parent)
        await this.deps.ledger.record({ ...entry, accountId: undefined, openedAt: 0 })
      }
      await this.deps.ledger.launchReceipts.save(
        receipt,
        args.workspaceId,
        entry,
        confirmedAccountLabel,
        confirmedAccountIdentity
      )
      this.plans.delete(args.planToken)
      this.receipts.set(receipt, stagedReceipt)
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
    } finally {
      pending.preparing = false
    }
  }

  private async preview(
    args: AiVaultPrepareSessionResumeArgs
  ): Promise<AiVaultPrepareSessionResumeResult> {
    const pending = await previewHistoryResume(this.deps, args)
    this.plans.set(pending.plan.token, pending)
    return { useRealCodexHome: false, resumePlan: pending.plan }
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
