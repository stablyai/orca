export type StructuredAgentSessionHolderRegistration = {
  token: symbol
  active: boolean
}

export class StructuredAgentSessionHolders {
  private readonly registrations = new Map<string, StructuredAgentSessionHolderRegistration>()

  get size(): number {
    return this.registrations.size
  }

  add(
    holderId: string,
    active: boolean
  ): { alreadyHeld: boolean; registration: StructuredAgentSessionHolderRegistration } {
    const existing = this.registrations.get(holderId)
    if (existing) {
      return { alreadyHeld: true, registration: existing }
    }
    const registration = { token: Symbol(holderId), active }
    this.registrations.set(holderId, registration)
    return { alreadyHeld: false, registration }
  }

  isCurrent(holderId: string, registration: StructuredAgentSessionHolderRegistration): boolean {
    return this.registrations.get(holderId)?.token === registration.token
  }

  remove(holderId: string): boolean {
    const holder = this.registrations.get(holderId)
    if (!holder) {
      return false
    }
    this.registrations.delete(holderId)
    return holder.active && !this.hasActive()
  }

  hasActive(): boolean {
    for (const holder of this.registrations.values()) {
      if (holder.active) {
        return true
      }
    }
    return false
  }

  forget(preservePending: boolean): void {
    for (const [holderId, holder] of this.registrations) {
      if (holder.active || !preservePending) {
        this.registrations.delete(holderId)
      }
    }
  }

  get(holderId: string): StructuredAgentSessionHolderRegistration | undefined {
    return this.registrations.get(holderId)
  }

  clear(): void {
    this.registrations.clear()
  }
}
