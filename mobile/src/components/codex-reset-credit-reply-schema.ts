import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Reset-credit schemas match runtime status.get and accounts.consumeCodexResetCredit handlers.

// Missing/unreadable capabilities mean unsupported; optional string array drops malformed list whole. object-result-or-null keeps foreign payload nonthrowing.
export const codexResetCapabilityListSchema = z
  .looseObject({
    capabilities: salvagedOptional('capabilities', z.array(z.string()))
  })
  .transform((reply) => reply.capabilities)

// Forward opaque redeem reply: decodeResetResult owns scope/status/outcome/retryDisposition validation and user sentence; duplicate reader checks would split refusal rule.
export const codexResetCreditReplySchema = z.unknown()

// Pair host runtime with no distro, WSL runtime with exact distro, matching host contract.
export const CodexResetCreditExpectedScopeSchema = z
  .strictObject({
    target: z.strictObject({
      runtime: z.enum(['host', 'wsl']),
      wslDistro: z.string().min(1).max(255).nullable()
    }),
    accountId: z.string().min(1).max(512),
    accountRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    offerRevision: z.string().startsWith('v1:').max(4_096)
  })
  .superRefine((scope, context) => {
    if (scope.target.runtime === 'host' && scope.target.wslDistro !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Host reset scopes cannot name a WSL distro',
        path: ['target', 'wslDistro']
      })
    }
    if (
      scope.target.runtime === 'wsl' &&
      (scope.target.wslDistro === null || scope.target.wslDistro.trim() !== scope.target.wslDistro)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'WSL reset scopes require an exact distro',
        path: ['target', 'wslDistro']
      })
    }
  })
