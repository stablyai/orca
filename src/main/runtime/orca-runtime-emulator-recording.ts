import { EmulatorError } from '../emulator/emulator-errors'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import type { EmulatorRecordingInfo } from '../emulator/backends/emulator-backend'
import {
  ensureEmulatorRecordingsDir,
  resolveEmulatorRecordingPath
} from '../emulator/emulator-recording-path'
import { getAppEnvironment } from '../../shared/app-environment'

// Why: separate file for the recording surface (parallel to orca-runtime-emulator.ts),
// which is at its line budget and owns device/input routing rather than capture.
export type RuntimeEmulatorRecordingHost = {
  getEmulatorBridge(): EmulatorBridge | null
  resolveEmulatorWorkspaceId(selector: string): Promise<string>
}

type RecordTargetParams = { device?: string; emulator?: string; worktree?: string }

export class RuntimeEmulatorRecordingCommands {
  constructor(private readonly host: RuntimeEmulatorRecordingHost) {}

  // `name` is only a filename hint from the pane (which knows the display name);
  // the CLI omits it and falls back to the device selector.
  async emulatorRecordStart(
    params: RecordTargetParams & { path?: string; name?: string }
  ): Promise<EmulatorRecordingInfo> {
    const { bridge, device, worktreeId } = await this.resolveTarget(params)
    const recordingsDir = await ensureEmulatorRecordingsDir(getAppEnvironment().getPath('userData'))
    const outputPath = resolveEmulatorRecordingPath(
      recordingsDir,
      params.name ?? device ?? 'emulator',
      params.path
    )
    return bridge.runCapability('record', { device, worktreeId }, (backend, resolved) =>
      backend.startRecording!(resolved, outputPath)
    )
  }

  async emulatorRecordStop(params: RecordTargetParams): Promise<EmulatorRecordingInfo> {
    const { bridge, device, worktreeId } = await this.resolveTarget(params)
    return bridge.runCapability('record', { device, worktreeId }, (backend, resolved) =>
      backend.stopRecording!(resolved)
    )
  }

  private async resolveTarget(
    params: RecordTargetParams
  ): Promise<{ bridge: EmulatorBridge; device?: string; worktreeId?: string }> {
    const bridge = this.host.getEmulatorBridge()
    if (!bridge) {
      throw new EmulatorError('emulator_no_active', 'No emulator session is active')
    }
    const worktreeId = params.worktree
      ? await this.host.resolveEmulatorWorkspaceId(params.worktree)
      : undefined
    return { bridge, device: params.device ?? params.emulator, worktreeId }
  }
}
