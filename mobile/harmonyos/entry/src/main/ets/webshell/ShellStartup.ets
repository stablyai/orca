/** One first-paint verdict per document, bounded across download and page initialization. */
export class ShellStartup {
  private timer: number = -1;
  private generation: number = 0;
  private pending: boolean = false;
  private failed: (message: string) => void;
  constructor(failed: (message: string) => void) { this.failed = failed; }
  begin(timeout: number = 45000): number {
    this.cancel(); this.pending = true;
    let generation = this.generation;
    this.timer = setTimeout((): void => this.fail(generation, '会话页面启动超时，请重试'), timeout);
    return generation;
  }
  complete(generation: number): boolean {
    if (!this.pending || generation !== this.generation) { return false; }
    this.pending = false; this.clearTimer(); return true;
  }
  fail(generation: number, message: string): void {
    if (!this.pending || generation !== this.generation) { return; }
    this.pending = false; this.clearTimer(); this.failed(message);
  }
  cancel(): void { this.generation++; this.pending = false; this.clearTimer(); }
  private clearTimer(): void { if (this.timer >= 0) { clearTimeout(this.timer); this.timer = -1; } }
}
