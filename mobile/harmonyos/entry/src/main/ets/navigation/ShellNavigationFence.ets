export class ShellNavigationFence {
  private revision: number = 0;
  private pending: number = 0;

  visit(): void { this.pending = 0; this.invalidateCallbacks(); }
  invalidateCallbacks(): void { this.revision++; }
  stamp(): number { return this.revision; }
  isPending(): boolean { return this.pending !== 0; }

  begin(): number {
    if (this.pending !== 0) { return 0; }
    this.pending = ++this.revision;
    return this.pending;
  }

  reject(attempt: number): void {
    if (this.pending === attempt) { this.visit(); }
  }
}
