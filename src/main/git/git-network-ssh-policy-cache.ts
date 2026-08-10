export class GitNetworkSshPolicyCache {
  private readonly entries = new Map<string, Promise<string>>()

  resolve(scope: string, load: () => Promise<string>): Promise<string> {
    const existing = this.entries.get(scope)
    if (existing) {
      return existing
    }

    const pending = load()
    this.entries.set(scope, pending)
    void pending.catch(() => {
      if (this.entries.get(scope) === pending) {
        this.entries.delete(scope)
      }
    })
    return pending
  }
}

export function createGitNetworkSshPolicyCache(): GitNetworkSshPolicyCache {
  return new GitNetworkSshPolicyCache()
}
