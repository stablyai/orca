import { DEFAULT_PTY_SOURCE_WINDOW_SU } from '../../shared/pty-source-credit-contract'
import { chargedPtyRetainedStringBytes } from '../../shared/pty-retained-string-memory'

export const SSH_PTY_RECOVERY_PER_PTY_MAX_SOURCE_SU = DEFAULT_PTY_SOURCE_WINDOW_SU
export const SSH_PTY_RECOVERY_PER_PTY_MAX_BYTES = 2 * 1024 * 1024
export const SSH_PTY_RECOVERY_PER_PTY_MAX_FRAMES = 1_024
export const SSH_PTY_RECOVERY_SESSION_MAX_SOURCE_SU = 50 * DEFAULT_PTY_SOURCE_WINDOW_SU
export const SSH_PTY_RECOVERY_SESSION_MAX_BYTES = 64 * 1024 * 1024
export const SSH_PTY_RECOVERY_SESSION_MAX_FRAMES = 64 * 1_024

export type SshPtyRecoveryRetentionLimits = Readonly<{
  perPtySourceSu: number
  perPtyBytes: number
  perPtyFrames: number
  sessionSourceSu: number
  sessionBytes: number
  sessionFrames: number
}>

type RetainedPty = {
  sourceSu: number
  bytes: number
  frames: number
}

const DEFAULT_LIMITS: SshPtyRecoveryRetentionLimits = Object.freeze({
  perPtySourceSu: SSH_PTY_RECOVERY_PER_PTY_MAX_SOURCE_SU,
  perPtyBytes: SSH_PTY_RECOVERY_PER_PTY_MAX_BYTES,
  perPtyFrames: SSH_PTY_RECOVERY_PER_PTY_MAX_FRAMES,
  sessionSourceSu: SSH_PTY_RECOVERY_SESSION_MAX_SOURCE_SU,
  sessionBytes: SSH_PTY_RECOVERY_SESSION_MAX_BYTES,
  sessionFrames: SSH_PTY_RECOVERY_SESSION_MAX_FRAMES
})

export class SshPtyRecoveryRetentionBudget {
  private readonly retainedByPty = new Map<string, RetainedPty>()
  private sourceSu = 0
  private bytes = 0
  private frames = 0

  constructor(private readonly limits: SshPtyRecoveryRetentionLimits = DEFAULT_LIMITS) {}

  tryRetain(ptyId: string, data: string, sourceSu: number): boolean {
    if (!Number.isSafeInteger(sourceSu) || sourceSu < 0) {
      return false
    }
    const retained = this.retainedByPty.get(ptyId) ?? { sourceSu: 0, bytes: 0, frames: 0 }
    const chargedBytes = chargedPtyRetainedStringBytes(data)
    if (
      retained.sourceSu + sourceSu > this.limits.perPtySourceSu ||
      retained.bytes + chargedBytes > this.limits.perPtyBytes ||
      retained.frames + 1 > this.limits.perPtyFrames ||
      this.sourceSu + sourceSu > this.limits.sessionSourceSu ||
      this.bytes + chargedBytes > this.limits.sessionBytes ||
      this.frames + 1 > this.limits.sessionFrames
    ) {
      return false
    }
    retained.sourceSu += sourceSu
    retained.bytes += chargedBytes
    retained.frames++
    this.retainedByPty.set(ptyId, retained)
    this.sourceSu += sourceSu
    this.bytes += chargedBytes
    this.frames++
    return true
  }

  release(ptyId: string): void {
    const retained = this.retainedByPty.get(ptyId)
    if (!retained) {
      return
    }
    this.retainedByPty.delete(ptyId)
    this.sourceSu -= retained.sourceSu
    this.bytes -= retained.bytes
    this.frames -= retained.frames
  }

  clear(): void {
    this.retainedByPty.clear()
    this.sourceSu = 0
    this.bytes = 0
    this.frames = 0
  }

  snapshot(): Readonly<{ sourceSu: number; bytes: number; frames: number; ptys: number }> {
    return Object.freeze({
      sourceSu: this.sourceSu,
      bytes: this.bytes,
      frames: this.frames,
      ptys: this.retainedByPty.size
    })
  }
}
