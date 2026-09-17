// One reconcile's tenure as the coordinator's current authority. A waiter parks on the authority
// it joined; either that reconcile returning or a newer authority taking over releases it. Because
// replacing the authority is the only way to end one, there is no wake call to forget.
export class RelayAuthority {
  private readonly done = Promise.withResolvers<void>()
  private readonly turnover = Promise.withResolvers<void>()
  readonly ended: Promise<void> = this.turnover.promise
  readonly settled: Promise<void> = Promise.race([this.done.promise, this.turnover.promise])

  // Nothing is running: before the first reconcile, and after a fence. A waiter that joins one is
  // told so on its next pass rather than parking behind an open the fence already abandoned.
  static idle(): RelayAuthority {
    const authority = new RelayAuthority()
    authority.done.resolve()
    return authority
  }

  static running(run: (authority: RelayAuthority) => Promise<void>): RelayAuthority {
    const authority = new RelayAuthority()
    void run(authority).finally(() => {
      authority.done.resolve()
    })
    return authority
  }

  end(): void {
    this.turnover.resolve()
  }
}
