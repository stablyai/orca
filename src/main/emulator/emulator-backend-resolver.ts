import { platform } from 'node:os'
import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionRegistry } from './emulator-session-registry'
import type {
  EmulatorBackend,
  EmulatorBackendKind,
  EmulatorTargetOpts
} from './backends/emulator-backend'

export class EmulatorBackendResolver {
  private readonly backends: EmulatorBackend[]
  private readonly sessionRegistry: EmulatorSessionRegistry

  constructor(backends: EmulatorBackend[], sessionRegistry: EmulatorSessionRegistry) {
    this.backends = backends
    this.sessionRegistry = sessionRegistry
  }

  forKind(kind: EmulatorBackendKind): EmulatorBackend | null {
    return this.backends.find((backend) => backend.kind === kind) ?? null
  }

  forActiveWorktree(worktreeId: string): EmulatorBackend | null {
    const key = this.sessionRegistry.getActiveSessionKey(worktreeId)
    if (!key) {
      return null
    }
    const session = this.sessionRegistry.getSession(key)
    return session ? this.forKind(session.backend) : null
  }

  async forDevice(device: string): Promise<EmulatorBackend> {
    for (const backend of this.backends) {
      if (await backend.ownsDevice(device)) {
        return backend
      }
    }
    // Why: fall back to a host-supported backend, else the platform-primary one,
    // so an unrecognized device surfaces the right setup error.
    return (
      this.backends.find((backend) => backend.isSupportedOnHost()) ??
      this.forKind(platform() === 'darwin' ? 'ios' : 'android')!
    )
  }

  async resolveTarget(
    opts?: EmulatorTargetOpts
  ): Promise<{ backend: EmulatorBackend; device: string }> {
    const explicit = opts?.device ?? opts?.emulator
    if (explicit) {
      return { backend: await this.forDevice(explicit), device: explicit }
    }
    if (opts?.worktreeId) {
      const active = this.sessionRegistry.getActiveForWorktree(opts.worktreeId)
      const backend = this.forActiveWorktree(opts.worktreeId)
      if (active && backend) {
        return { backend, device: active.deviceUdid }
      }
    }
    throw new EmulatorError(
      'emulator_no_active',
      'No active emulator for this worktree — use orca emulator attach or open the pane'
    )
  }

  async resolveStopTarget(
    device?: string,
    worktreeId?: string
  ): Promise<{ backend: EmulatorBackend; udid: string }> {
    if (device) {
      const backend = await this.forDevice(device)
      return { backend, udid: await backend.resolveDeviceId(device) }
    }
    const { backend, device: resolved } = await this.resolveTarget({ worktreeId })
    return { backend, udid: await backend.resolveDeviceId(resolved) }
  }
}
