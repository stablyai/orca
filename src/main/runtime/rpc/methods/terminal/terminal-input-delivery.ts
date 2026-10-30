import {
  isTerminalInputPaused,
  TerminalInputPausedError,
  type TerminalInputSource
} from '../../../terminal-input-admission'
import type { RpcCallerIdentity } from '../../rpc-caller-identity'
import { InvalidArgumentError } from '../../core'
import type { RuntimeTerminalSend } from '../../../../../shared/runtime-terminal-send-contract'
import type { DriverState, OrcaRuntimeService } from '../../../orca-runtime'
import {
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR,
  isTerminalInputTooLargeWithYield
} from '../../../../../shared/terminal-input'
import type { TerminalViewportClient } from './terminal-stream-types'

export function terminalInputSourceForClient(
  client: TerminalViewportClient | undefined,
  caller?: RpcCallerIdentity
): TerminalInputSource {
  if (client?.type === 'mobile') {
    return 'mobile'
  }
  if (!client) {
    return 'legacy'
  }
  if (caller?.kind === 'local-cli') {
    return 'programmatic'
  }
  // Paired CLI versions already declare this source; authentication and floor remain unchanged.
  if (caller?.kind === 'paired-device' && client.type === 'desktop' && client.id === 'orca-cli') {
    return 'programmatic'
  }
  return 'desktop'
}

export function isTerminalInputLockedForClient(
  runtime: OrcaRuntimeService,
  ptyId: string,
  client: TerminalViewportClient | undefined
): boolean {
  return isTerminalInputPaused(runtime, ptyId, terminalInputSourceForClient(client))
}

export async function assertTerminalSendTextWithinLimit(text: string | undefined): Promise<void> {
  if (!text) {
    return
  }
  // Validate paste-sized payloads outside Zod so large requests yield before dispatch.
  if (await isTerminalInputTooLargeWithYield(text, TERMINAL_INPUT_MAX_BYTES)) {
    throw new InvalidArgumentError(TERMINAL_INPUT_TOO_LARGE_ERROR)
  }
}

export function resolveMobileFloorClientId(
  driver: DriverState | null,
  client: TerminalViewportClient | undefined
): string | null {
  if (client?.type === 'mobile') {
    return client.id
  }
  if (!client && driver?.kind === 'mobile') {
    return driver.clientId
  }
  return null
}

export type TerminalStreamInputOutcome = 'delivered' | 'rejected' | 'failed' | 'paused'

function isTerminalStreamInputRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('terminal_not_writable') || message.includes('terminal_handle_stale')
}

export async function sendTerminalStreamInput(
  runtime: OrcaRuntimeService,
  args: {
    terminal: string
    text: string
    client: TerminalViewportClient | undefined
    isMobile: boolean
    /** Waits for the provider's handoff; one that may have written is `failed`, not `rejected`. */
    requireWriteSettlement?: boolean
  }
): Promise<TerminalStreamInputOutcome> {
  const inputSource = terminalInputSourceForClient(args.client)
  const action = { text: args.text, enter: false, interrupt: false }
  const clientId = args.isMobile ? args.client?.id : undefined
  const floorClaim: MobileInputFloorClaimHolder = { current: null }
  const settlement = args.requireWriteSettlement ? { requireWriteSettlement: true as const } : {}
  try {
    const result = await runtime.sendTerminal(args.terminal, action, {
      inputKind: 'driving',
      inputSource,
      ...settlement,
      ...(clientId
        ? {
            reserveWrite: (writePtyId: string) => {
              const claim = runtime.beginMobileInputFloor(writePtyId, clientId)
              if (!claim) {
                throw new Error('mobile_input_floor_unavailable')
              }
              floorClaim.current = claim
            },
            afterWrite: () => commitMobileInputFloorClaim(floorClaim)
          }
        : {})
    })
    const outcome = streamInputOutcome(result)
    if (outcome === 'rejected') {
      floorClaim.current?.rollback()
    }
    return outcome
  } catch (error) {
    floorClaim.current?.rollback()
    if (error instanceof TerminalInputPausedError) {
      return 'paused'
    }
    return isTerminalStreamInputRejection(error) ? 'rejected' : 'failed'
  }
}

function streamInputOutcome(result: RuntimeTerminalSend): TerminalStreamInputOutcome {
  if (result.writeSettlement?.outcome === 'unverifiable') {
    // Why: only bytes that may already be in flight are ambiguous; the rest are a proven refusal.
    return result.writeSettlement.bytesHandedToTransport ? 'failed' : 'rejected'
  }
  return result.accepted ? 'delivered' : 'rejected'
}

export type MobileInputFloorClaimHolder = {
  current: ReturnType<OrcaRuntimeService['beginMobileInputFloor']>
}

export async function commitMobileInputFloorClaim(
  claim: MobileInputFloorClaimHolder
): Promise<void> {
  const current = claim.current
  if (!current) {
    return
  }
  try {
    await current.commit()
  } finally {
    // After runtime yields, reserve again if desktop reclaimed the floor before the next write.
    if (claim.current === current) {
      claim.current = null
    }
  }
}

export function getTerminalSendGuardRefusedReason(
  error: unknown
): 'no-agent' | 'permission' | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('terminal_guard_permission')) {
    return 'permission'
  }
  if (message.includes('terminal_guard_no_agent')) {
    return 'no-agent'
  }
  return undefined
}

export function isTerminalSendGuardNotWritable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('terminal_guard_not_writable')
}

export function assertTerminalSendExactPtyBinding(
  runtime: OrcaRuntimeService,
  handle: string,
  expectedPtyId: string | undefined
): void {
  try {
    if (expectedPtyId && runtime.resolveLiveLeafForHandle(handle)?.ptyId === expectedPtyId) {
      return
    }
  } catch {
    // Fall through to the stable guarded-send result below.
  }
  throw new Error('terminal_guard_not_writable')
}
