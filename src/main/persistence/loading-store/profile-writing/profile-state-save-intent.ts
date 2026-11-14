/** Unannotated writes may mutate existing field references, so they always require a full domain. */
export class ProfileStateSaveIntent extends Set<string> {
  private readonly fieldDomains = new Set<string>()

  constructor() {
    super()
  }

  override add(domain: string): this {
    this.fieldDomains.delete(domain)
    return super.add(domain)
  }

  addFields(domain: string): void {
    if (!this.has(domain)) {
      super.add(domain)
      this.fieldDomains.add(domain)
    }
  }

  hasFields(domain: string): boolean {
    return this.fieldDomains.has(domain)
  }

  restore(captured: ReadonlySet<string>): void {
    for (const domain of captured) {
      if (captured instanceof ProfileStateSaveIntent && captured.hasFields(domain)) {
        this.addFields(domain)
      } else {
        this.add(domain)
      }
    }
  }
}
