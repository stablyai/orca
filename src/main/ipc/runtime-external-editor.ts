import { posix, win32 } from 'node:path'
import { isCursorRemoteSshCommand } from '../../shared/cursor-remote-ssh-launcher'
import { parseExecutionHostId } from '../../shared/execution-host'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult
} from '../../shared/shell-open-types'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { isZedRemoteSshCommand } from '../../shared/zed-remote-ssh-launcher'
import type { Store } from '../persistence'
import {
  launchExternalEditor,
  resolveCursorRemoteSshLaunchSpec,
  resolveVsCodeRemoteSshLaunchSpec
} from '../external-editor-launch'
import { resolveZedRemoteSshLaunchSpec } from '../zed-remote-ssh-launch'
import { resolveRuntimeEnvironmentEditorSshTarget } from '../runtime-environment-editor-ssh-target'
import { resolveVsCodeSshAuthority } from '../ssh/vscode-ssh-authority'

export type RuntimeExternalEditorDependencies = {
  resolveRuntimeEnvironment?: (environmentId: string) => KnownRuntimeEnvironment | undefined
}

export async function openRuntimePathInExternalEditor(
  store: Store,
  request: ShellOpenExternalEditorRequest,
  dependencies: RuntimeExternalEditorDependencies
): Promise<ShellOpenExternalEditorResult> {
  const executionHost = parseExecutionHostId(request.executionHostId)
  if (executionHost?.kind !== 'runtime' || request.connectionId?.trim()) {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }
  if (!posix.isAbsolute(request.path) && !win32.isAbsolute(request.path)) {
    return { ok: false, reason: 'not-absolute' }
  }

  let environment: KnownRuntimeEnvironment | undefined
  try {
    environment = dependencies.resolveRuntimeEnvironment?.(executionHost.environmentId)
  } catch {
    environment = undefined
  }
  if (!environment) {
    return { ok: false, reason: 'runtime-ssh-target-required' }
  }
  const target = resolveRuntimeEnvironmentEditorSshTarget(environment, store.getSshTargets())
  if (!target.ok) {
    return target
  }
  const authority = resolveVsCodeSshAuthority(target.target)
  if (!authority.ok) {
    return authority
  }
  const launchSpec = isZedRemoteSshCommand(request.command)
    ? resolveZedRemoteSshLaunchSpec(request.command, request.path, authority.authority)
    : isCursorRemoteSshCommand(request.command)
      ? resolveCursorRemoteSshLaunchSpec(request.command, request.path, authority.authority)
      : resolveVsCodeRemoteSshLaunchSpec(request.command, request.path, authority.authority)
  if (!launchSpec) {
    return { ok: false, reason: 'remote-editor-unsupported' }
  }
  try {
    await launchExternalEditor(launchSpec)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
}
