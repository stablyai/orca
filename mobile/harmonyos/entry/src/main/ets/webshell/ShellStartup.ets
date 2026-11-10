export type ShellDocumentFailure = 'page' | 'renderer';

/** One first-paint verdict per document, bounded by inactivity. */
export class ShellStartup {
  private timer: number = -1;
  private generation: number = 0;
  private pending: boolean = false;
  private timeout: number = 45000;
  private pageRemounted: boolean = false;
  private rendererRemounted: boolean = false;
  private failed: (message: string) => void;
  constructor(failed: (message: string) => void) { this.failed = failed; }
  begin(timeout: number = 45000): number {
    this.cancel(); this.pending = true;
    this.timeout = timeout;
    this.progress(this.generation);
    return this.generation;
  }
  progress(generation: number): void {
    if (!this.pending || generation !== this.generation) { return; }
    this.clearTimer();
    this.timer = setTimeout((): void => this.fail(generation, '会话页面启动超时，请重试'), this.timeout);
  }
  complete(generation: number): boolean {
    if (!this.pending || generation !== this.generation) { return false; }
    this.pending = false; this.rendererRemounted = false; this.clearTimer(); return true;
  }
  allowRemount(reason: ShellDocumentFailure): boolean {
    if (reason === 'page') {
      if (this.pageRemounted) { return false; }
      this.pageRemounted = true; return true;
    }
    if (this.rendererRemounted) { return false; }
    this.rendererRemounted = true; return true;
  }
  resetRecovery(): void { this.pageRemounted = false; this.rendererRemounted = false; }
  fail(generation: number, message: string): void {
    if (!this.pending || generation !== this.generation) { return; }
    this.pending = false; this.clearTimer(); this.failed(message);
  }
  cancel(): void { this.generation++; this.pending = false; this.clearTimer(); }
  private clearTimer(): void { if (this.timer >= 0) { clearTimeout(this.timer); this.timer = -1; } }
}
