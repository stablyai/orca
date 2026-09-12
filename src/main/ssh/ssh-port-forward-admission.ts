import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

type Settlement = { ok: true } | { ok: false; error: unknown }

/** A reset drains already-admitted publication before capturing the listener cohort. */
export class SshPortForwardAdmission {
  private readonly pending = new Map<string, Set<Promise<Settlement>>>()
  private readonly fences = new Map<string, object>()
  private readonly activity = new Map<string, object>()

  assertAbsent(targetId: string): void {
    if (this.pending.has(targetId) || this.fences.has(targetId)) {
      throw new Error('ssh_port_forward_admission_still_retained')
    }
  }

  async run<T>(targetId: string, operation: () => Promise<T>): Promise<T> {
    if (this.fences.has(targetId)) {
      throw new Error('ssh_port_forward_admission_closed')
    }
    this.activity.set(targetId, {})
    const completion = Promise.withResolvers<Settlement>()
    const pending = this.pending.get(targetId) ?? new Set<Promise<Settlement>>()
    this.pending.set(targetId, pending)
    pending.add(completion.promise)
    try {
      const result = await operation()
      completion.resolve({ ok: true })
      return result
    } catch (error) {
      completion.resolve({ ok: false, error })
      throw error
    } finally {
      pending.delete(completion.promise)
      if (pending.size === 0) {
        this.pending.delete(targetId)
      }
    }
  }

  fence(targetId: string) {
    if (this.fences.has(targetId)) {
      throw new Error('ssh_port_forward_admission_already_closed')
    }
    const token = {}
    this.fences.set(targetId, token)
    this.activity.set(targetId, token)
    const pending = [...(this.pending.get(targetId) ?? [])]
    let drained = false
    const assertClosed = () => {
      if (this.fences.get(targetId) !== token) {
        throw new Error('ssh_port_forward_admission_fence_changed')
      }
    }
    return {
      assertClosed,
      async drain(signal?: AbortSignal): Promise<void> {
        assertClosed()
        const results = await waitForPromiseWithSignal(Promise.all(pending), signal)
        assertClosed()
        for (const result of results) {
          if (!result.ok) {
            throw result.error
          }
        }
        drained = true
      },
      assertDrained: () => {
        assertClosed()
        if (!drained || this.pending.get(targetId)?.size) {
          throw new Error('ssh_port_forward_publication_unconfirmed')
        }
      },
      release: (assertReleaseAuthorized: () => void) => {
        assertClosed()
        assertReleaseAuthorized()
        assertClosed()
        this.fences.delete(targetId)
        return {
          assertReleased: () => {
            if (
              this.activity.get(targetId) !== token ||
              this.fences.has(targetId) ||
              this.pending.has(targetId)
            ) {
              throw new Error('ssh_port_forward_released_admission_changed')
            }
          }
        }
      }
    }
  }
}
