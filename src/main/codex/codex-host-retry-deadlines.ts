import {
  MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS,
  type CodexAppServerHostKey
} from './codex-app-server-capability-cache'

export class CodexHostRetryDeadlines {
  private readonly deadlineByHost = new Map<CodexAppServerHostKey, number>()

  get(hostKey: CodexAppServerHostKey): number | undefined {
    const deadline = this.deadlineByHost.get(hostKey)
    if (deadline !== undefined) {
      this.deadlineByHost.delete(hostKey)
      this.deadlineByHost.set(hostKey, deadline)
    }
    return deadline
  }

  set(hostKey: CodexAppServerHostKey, deadline: number): void {
    this.deadlineByHost.delete(hostKey)
    this.deadlineByHost.set(hostKey, deadline)
    while (this.deadlineByHost.size > MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS) {
      const oldestHost = this.deadlineByHost.keys().next().value
      if (oldestHost === undefined) {
        return
      }
      this.deadlineByHost.delete(oldestHost)
    }
  }

  delete(hostKey: CodexAppServerHostKey): void {
    this.deadlineByHost.delete(hostKey)
  }

  clear(): void {
    this.deadlineByHost.clear()
  }

  sizeForTest(): number {
    return this.deadlineByHost.size
  }
}
