import type {
  HookBinding,
  TerminalInterfaceOwner,
  TerminalInterfaceTarget
} from './terminal-interface-contracts'

export class TerminalInterfaceHookIngress {
  constructor(
    private readonly inventory: () => TerminalInterfaceTarget[],
    private readonly accept: (
      paneKey: string,
      binding: HookBinding,
      owner: TerminalInterfaceOwner
    ) => void
  ) {}
  reset(): void {
    this.resolveHook = null
    this.startupBindings.clear()
  }
  private resolveHook: ((paneKey: string) => HookBinding | null) | null = null
  private startupBindings = new Map<string, HookBinding>()
  private readonly startupHooks = new Map<
    string,
    { handle?: string; owner: TerminalInterfaceOwner }
  >()

  /** Called once recovery has restored the same attach inventory used by hook identity capture. */
  attachHookBindings(resolve: (paneKey: string) => HookBinding | null): void {
    this.resolveHook = resolve
    this.startupBindings = new Map(
      this.inventory().map(
        (target) =>
          [
            target.binding.paneKey,
            {
              terminalHandle: target.binding.terminalHandle,
              incarnationId: target.binding.incarnationId,
              generation: target.generation
            }
          ] as const
      )
    )
    for (const [paneKey, pending] of this.startupHooks) {
      const binding = this.startupBindings.get(paneKey)
      if (binding && (!pending.handle || pending.handle === binding.terminalHandle)) {
        this.accept(paneKey, binding, pending.owner)
      }
    }
    this.startupHooks.clear()
  }

  /** Capture before admission; an already attached runtime never remints an unresolved receipt. */
  captureHook(paneKey: string, handle?: string): (owner: TerminalInterfaceOwner) => void {
    const resolve = this.resolveHook
    const binding = resolve?.(paneKey) ?? null
    return (owner) => {
      if (!resolve) {
        this.acceptStartup(paneKey, handle, owner)
      } else if (binding && (!handle || handle === binding.terminalHandle)) {
        this.accept(paneKey, binding, owner)
      }
    }
  }

  private acceptStartup(
    paneKey: string,
    handle: string | undefined,
    owner: TerminalInterfaceOwner
  ): void {
    if (this.resolveHook) {
      const binding = this.startupBindings.get(paneKey)
      if (binding && (!handle || handle === binding.terminalHandle)) {
        this.accept(paneKey, binding, owner)
      }
      return
    }
    this.startupHooks.set(paneKey, { handle, owner })
    while (this.startupHooks.size > 1024) {
      const oldest = this.startupHooks.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.startupHooks.delete(oldest)
    }
  }

  /** Freeze the request's inventory before owner checks or normalization can await. */
  captureIngress(): (paneKey: string, handle?: string) => (owner: TerminalInterfaceOwner) => void {
    const bindings = new Map(
      this.inventory().map(
        (target) =>
          [
            target.binding.paneKey,
            {
              terminalHandle: target.binding.terminalHandle,
              incarnationId: target.binding.incarnationId,
              generation: target.generation
            }
          ] as const
      )
    )
    const startup = this.resolveHook === null
    return (paneKey, handle) => {
      const binding = bindings.get(paneKey)
      if (!binding && startup) {
        return (owner) => this.acceptStartup(paneKey, handle, owner)
      }
      return (owner) => {
        if (binding && (!handle || binding.terminalHandle === handle)) {
          this.accept(paneKey, binding, owner)
        }
      }
    }
  }
}
