type DrainRegistration = { registered: boolean; remove: () => void }

/**
 * Holds the writer's single outstanding drain registration on its sink.
 *
 * Why it is re-checked after registering: a sink may invoke the drain callback synchronously from
 * inside registerDrain, which disarms this arm before registration returns. Storing the remove
 * handle then would cancel a later, still-wanted arm instead of the one that already fired.
 */
export class DispatcherWriterDrainArm {
  private armed = false
  private remove: (() => void) | null = null

  get isArmed(): boolean {
    return this.armed
  }

  arm(register: (onDrain: () => void) => DrainRegistration, onDrain: () => void): void {
    if (this.armed) {
      return
    }
    this.armed = true
    const registration = register(onDrain)
    if (!registration.registered) {
      this.armed = false
    } else if (this.armed) {
      this.remove = registration.remove
    } else {
      registration.remove()
    }
  }

  disarm(): void {
    this.armed = false
    const remove = this.remove
    this.remove = null
    remove?.()
  }
}
