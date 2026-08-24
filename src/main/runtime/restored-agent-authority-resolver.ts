export type RestoredAgentAuthorityHook = Readonly<{
  identity: string
  paneKey: string
  worktreeKey: string
  hostKey: string
  terminalHandle?: string
}>

export type RestoredAgentAuthorityBinding = Readonly<{
  ptyId: string
  incarnationId: string | null
  lifecycleGeneration: number
  source: 'current' | 'persisted'
  paneKey: string
  worktreeKey: string
  hostKey: string
  terminalHandle?: string
}>

export type RestoredAgentAuthorityResolution = Readonly<{
  binding: RestoredAgentAuthorityBinding | null
  hasExactBinding: boolean
}>

export class RestoredAgentAuthorityResolver {
  private readonly commitmentByHookIdentity = new Map<string, string>()

  resolve(args: {
    hook: RestoredAgentAuthorityHook
    current: RestoredAgentAuthorityBinding | null
    persisted: RestoredAgentAuthorityBinding | null
  }): RestoredAgentAuthorityResolution {
    const current = this.matchesHook(args.hook, args.current) ? args.current : null
    const persisted = this.matchesHook(args.hook, args.persisted) ? args.persisted : null
    if (current && persisted && !sameRestoredAgentProcessAuthority(current, persisted)) {
      return { binding: null, hasExactBinding: false }
    }
    const existing = this.commitmentByHookIdentity.get(args.hook.identity)
    if (!existing && !persisted) {
      return { binding: null, hasExactBinding: false }
    }
    const binding = current ?? persisted
    if (!binding) {
      return { binding: null, hasExactBinding: false }
    }
    const commitment = processAuthorityKey(binding)
    if (existing && existing !== commitment) {
      return { binding: null, hasExactBinding: false }
    }
    this.commitmentByHookIdentity.set(args.hook.identity, commitment)
    return { binding, hasExactBinding: true }
  }

  retain(hookIdentities: ReadonlySet<string>): void {
    for (const identity of this.commitmentByHookIdentity.keys()) {
      if (!hookIdentities.has(identity)) {
        this.commitmentByHookIdentity.delete(identity)
      }
    }
  }

  private matchesHook(
    hook: RestoredAgentAuthorityHook,
    binding: RestoredAgentAuthorityBinding | null
  ): binding is RestoredAgentAuthorityBinding {
    return Boolean(
      binding &&
      binding.paneKey === hook.paneKey &&
      binding.worktreeKey === hook.worktreeKey &&
      binding.hostKey === hook.hostKey &&
      (!hook.terminalHandle || binding.terminalHandle === hook.terminalHandle)
    )
  }
}

export function sameRestoredAgentProcessAuthority(
  left: RestoredAgentAuthorityBinding,
  right: RestoredAgentAuthorityBinding
): boolean {
  return processAuthorityKey(left) === processAuthorityKey(right)
}

function processAuthorityKey(binding: RestoredAgentAuthorityBinding): string {
  return JSON.stringify([
    binding.hostKey,
    binding.worktreeKey,
    binding.paneKey,
    binding.ptyId,
    binding.incarnationId === null
      ? ['generation', binding.lifecycleGeneration]
      : ['incarnation', binding.incarnationId]
  ])
}
