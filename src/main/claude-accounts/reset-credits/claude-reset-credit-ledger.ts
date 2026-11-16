import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  ClaudeResetCreditRequest,
  ClaudeResetCreditResult,
  ClaudeResetCredits
} from '../../../shared/agent-accounts/claude/claude-reset-credit-types'

import { ConsumeClaudeResetCreditParams } from '../../../shared/rpc-contract/accounts/accounts-params'

const receiptSchema = z.object({
  request: ConsumeClaudeResetCreditParams,
  beforeResetsLeft: z.number().int().positive(),
  afterResetsLeft: z.number().int().nonnegative().nullable(),
  result: z.object({
    requestId: z.uuid(),
    outcome: z.enum(['reset', 'already_used', 'not_limited', 'cooldown', 'ineligible', 'unknown']),
    cleared: z.array(z.string()),
    cooldownUntil: z.number().nullable(),
    verified: z.boolean(),
    credits: z.null()
  })
})

export class ClaudeResetCreditLedger {
  constructor(private readonly directory: string) {}

  async pending(organizationUuid: string): Promise<string | null> {
    try {
      return z
        .object({ requestId: z.uuid() })
        .parse(JSON.parse(await readFile(this.lockPath(organizationUuid), 'utf8'))).requestId
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw new Error('The previous Claude reset record could not be read. Reset is blocked.')
    }
  }

  async lookupResult(
    requestId: string,
    identity: ClaudeResetCreditRequest['identity']
  ): Promise<ClaudeResetCreditResult | null> {
    const receipt = await this.readReceipt(requestId)
    if (!receipt) {
      return null
    }
    if (
      receipt.request.identity.accountUuid !== identity.accountUuid ||
      receipt.request.identity.organizationUuid !== identity.organizationUuid
    ) {
      throw new Error('That operation ID belongs to a different Claude account.')
    }
    return receipt.result
  }

  async replay(request: ClaudeResetCreditRequest): Promise<ClaudeResetCreditResult | null> {
    const receipt = await this.readReceipt(request.requestId)
    if (!receipt) {
      return null
    }
    if (
      receipt.request.grantId !== request.grantId ||
      receipt.request.identity.accountUuid !== request.identity.accountUuid ||
      receipt.request.identity.organizationUuid !== request.identity.organizationUuid
    ) {
      throw new Error('That operation ID belongs to a different Claude reset.')
    }
    return receipt.result
  }

  async reconcile(
    identity: ClaudeResetCreditRequest['identity'],
    credits: ClaudeResetCredits | null
  ): Promise<string | null> {
    const pending = await this.pending(identity.organizationUuid)
    if (!pending || !credits) {
      return pending
    }
    const receipt = await this.readReceipt(pending)
    if (!receipt) {
      return pending
    }
    const after = credits.grants.find((grant) => grant.id === receipt.request.grantId)
    // A balance alone cannot prove an unknown POST succeeded; require the provider's reset receipt.
    if (
      receipt.request.identity.accountUuid === identity.accountUuid &&
      receipt.result.outcome === 'reset' &&
      after &&
      after.resetsLeft < receipt.beforeResetsLeft
    ) {
      await this.settle(receipt.request, { ...receipt.result, credits, verified: true })
      return null
    }
    return pending
  }

  async begin(request: ClaudeResetCreditRequest, beforeResetsLeft: number): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // The organization fence survives crashes and is shared by every account in this runtime.
    await writeFile(
      this.lockPath(request.identity.organizationUuid),
      JSON.stringify({ requestId: request.requestId }),
      {
        flag: 'wx',
        mode: 0o600,
        flush: true
      }
    ).catch(() => {
      throw new Error('A Claude reset for this organization is still awaiting confirmation.')
    })
    await writeFile(
      this.receiptPath(request.requestId),
      this.record(
        request,
        {
          requestId: request.requestId,
          outcome: 'unknown',
          cleared: [],
          cooldownUntil: null,
          verified: false,
          credits: null
        },
        beforeResetsLeft
      ),
      { flag: 'wx', mode: 0o600, flush: true }
    )
  }

  async settle(request: ClaudeResetCreditRequest, result: ClaudeResetCreditResult): Promise<void> {
    await this.saveResult(request, result)
    if (result.outcome !== 'unknown' && (result.outcome !== 'reset' || result.verified)) {
      const pending = await this.pending(request.identity.organizationUuid)
      if (pending === request.requestId) {
        await unlink(this.lockPath(request.identity.organizationUuid))
      }
    }
  }

  async saveResult(
    request: ClaudeResetCreditRequest,
    result: ClaudeResetCreditResult
  ): Promise<void> {
    const destination = this.receiptPath(request.requestId)
    const previous = receiptSchema.parse(JSON.parse(await readFile(destination, 'utf8')))
    const temporary = `${destination}.${randomUUID()}.tmp`
    await writeFile(temporary, this.record(request, result, previous.beforeResetsLeft), {
      flag: 'wx',
      mode: 0o600,
      flush: true
    })
    await rename(temporary, destination)
  }

  private async readReceipt(requestId: string) {
    try {
      return receiptSchema.parse(JSON.parse(await readFile(this.receiptPath(requestId), 'utf8')))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  private record(
    request: ClaudeResetCreditRequest,
    result: ClaudeResetCreditResult,
    beforeResetsLeft: number
  ): string {
    return JSON.stringify({
      request,
      recordedAt: Date.now(),
      beforeResetsLeft,
      afterResetsLeft:
        result.credits?.grants.find((grant) => grant.id === request.grantId)?.resetsLeft ?? null,
      result: { ...result, credits: null }
    })
  }

  private lockPath(organizationUuid: string): string {
    return join(this.directory, `${organizationUuid}.pending.json`)
  }

  private receiptPath(requestId: string): string {
    return join(this.directory, `${requestId}.json`)
  }
}
