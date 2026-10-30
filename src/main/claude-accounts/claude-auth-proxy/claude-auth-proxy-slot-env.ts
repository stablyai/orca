import type { ClaudeRuntimeAuthPreparation } from '../runtime-auth/runtime-auth-types'
import {
  claudeAuthProxyListeningPort,
  releaseOwnClaudeAuthProxySlot
} from './claude-auth-proxy-host'
import {
  bindClaudeAuthProxySlotToPty,
  claudeAuthProxySlotOwner
} from './claude-auth-proxy-slot-owners'
import { claudeAuthProxySlotId, isForeignClaudeAuthProxyUrl } from './claude-auth-proxy-url'

/**
 * A shell `terminalEnv` already took a slot. The launch patch is the account this spawn prepared.
 * Release the shell slot when the patch replaces it. A user base URL has no slot to release.
 * Returns whether the shell slot was released, so the caller can drop it from the applied env.
 */
export function releaseSupersededOwnProxySlot(
  baseUrl: string | undefined,
  patchUrl: string | undefined
): boolean {
  if (!baseUrl || !patchUrl) {
    return false
  }
  const baseSlot = claudeAuthProxySlotId(baseUrl)
  const patchSlot = claudeAuthProxySlotId(patchUrl)
  if (!baseSlot || !patchSlot || baseSlot === patchSlot) {
    return false
  }
  if (isForeignClaudeAuthProxyUrl(baseUrl, claudeAuthProxyListeningPort())) {
    return false
  }
  releaseOwnClaudeAuthProxySlot(baseSlot)
  return true
}

/**
 * Quota polls call `preparation()`, which allocates a slot the credential read never uses.
 * A slot already bound to a PTY is left alone.
 */
export function dropUnboundAuthProxySlot(
  prepared: ClaudeRuntimeAuthPreparation
): ClaudeRuntimeAuthPreparation {
  const url = prepared.envPatch?.ANTHROPIC_BASE_URL
  if (!url) {
    return prepared
  }
  const slot = claudeAuthProxySlotId(url)
  if (!slot || isForeignClaudeAuthProxyUrl(url, claudeAuthProxyListeningPort())) {
    return prepared
  }
  if (claudeAuthProxySlotOwner(slot)?.ptyId) {
    return prepared
  }
  releaseOwnClaudeAuthProxySlot(slot)
  const envPatch = { ...prepared.envPatch }
  delete envPatch.ANTHROPIC_BASE_URL
  return { ...prepared, envPatch }
}

/**
 * Bind the slot the process actually received. A reattach does not apply this spawn env to the
 * live process, so a slot minted into it is unused and is released.
 */
export function retainAppliedClaudeAuthProxySlot(args: {
  ptyId: string
  env: Record<string, string> | undefined
  isReattach: boolean
}): void {
  const url = args.env?.ANTHROPIC_BASE_URL
  if (!url) {
    return
  }
  const slot = claudeAuthProxySlotId(url)
  if (!slot || isForeignClaudeAuthProxyUrl(url, claudeAuthProxyListeningPort())) {
    return
  }
  if (args.isReattach) {
    if (!claudeAuthProxySlotOwner(slot)?.ptyId) {
      releaseOwnClaudeAuthProxySlot(slot)
    }
    return
  }
  bindClaudeAuthProxySlotToPty(slot, args.ptyId)
}
