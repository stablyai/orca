import type { EmulatorBridge } from '../emulator/emulator-bridge'

export type EmulatorTargetParams = { device?: string; emulator?: string; worktree?: string }

export type RuntimeEmulatorCapabilityCommandHost = {
  requireEmulatorBridge(): EmulatorBridge
  resolveWorktreeId(worktree?: string): Promise<string | undefined>
}

// Why: split out of orca-runtime-emulator.ts to stay under the max-lines
// limit (AGENTS.md: split the file, don't disable the rule).
export class RuntimeEmulatorCapabilityCommands {
  constructor(private readonly host: RuntimeEmulatorCapabilityCommandHost) {}

  private static readonly OK = { ok: true as const }

  async emulatorInstall(
    params: EmulatorTargetParams & { path: string; reinstall?: boolean }
  ): Promise<{ ok: true }> {
    const worktreeId = await this.host.resolveWorktreeId(params.worktree)
    await this.host
      .requireEmulatorBridge()
      .runCapability(
        'install',
        { device: params.device ?? params.emulator, worktreeId },
        (backend, device) =>
          backend.installApp!(device, params.path, { reinstall: params.reinstall })
      )
    return RuntimeEmulatorCapabilityCommands.OK
  }

  async emulatorLaunch(
    params: EmulatorTargetParams & { package: string; activity?: string }
  ): Promise<{ ok: true }> {
    const worktreeId = await this.host.resolveWorktreeId(params.worktree)
    await this.host
      .requireEmulatorBridge()
      .runCapability(
        'launch',
        { device: params.device ?? params.emulator, worktreeId },
        (backend, device) => backend.launchApp!(device, params.package, params.activity)
      )
    return RuntimeEmulatorCapabilityCommands.OK
  }

  async emulatorPermissions(
    params: EmulatorTargetParams & {
      op: 'grant' | 'revoke' | 'reset'
      package?: string
      permission?: string
    }
  ): Promise<{ ok: true }> {
    const worktreeId = await this.host.resolveWorktreeId(params.worktree)
    await this.host
      .requireEmulatorBridge()
      .runCapability(
        'permissions',
        { device: params.device ?? params.emulator, worktreeId },
        (backend, device) =>
          backend.setPermission!(device, params.op, params.package ?? '', params.permission)
      )
    return RuntimeEmulatorCapabilityCommands.OK
  }

  async emulatorAx(params: EmulatorTargetParams): Promise<unknown> {
    const worktreeId = await this.host.resolveWorktreeId(params.worktree)
    return this.host.requireEmulatorBridge().accessibilityTree({
      device: params.device ?? params.emulator,
      worktreeId
    })
  }

  async emulatorLogcat(
    params: EmulatorTargetParams & { lines?: number; filters?: string[] }
  ): Promise<unknown> {
    const worktreeId = await this.host.resolveWorktreeId(params.worktree)
    return this.host
      .requireEmulatorBridge()
      .runCapability(
        'logcat',
        { device: params.device ?? params.emulator, worktreeId },
        (backend, device) =>
          backend.logcat!(device, { lines: params.lines, filters: params.filters })
      )
  }
}
