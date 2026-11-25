import { posix } from 'node:path'
import {
  DOUBAO_MODEL_LIST_ARGS,
  parseDoubaoModelList
} from '../../../../shared/agent-session/options/model-catalog/doubao-model-list-probe'
import { getAgentModelProbeSpec } from '../../../../shared/agent-session/options/model-catalog/agent-model-probe-spec'
import { InFlightPromiseDedupe } from '../../../../shared/concurrency/in-flight-promise-dedupe'
import { isWindowsAbsolutePathLike } from '../../../../shared/file-access/cross-platform-path'
import { quotePosixShell } from '../../../../shared/shell/launch/shell-argument-quoting'
import { quotePowerShellLiteral } from '../../../../shared/shell/launch/powershell-native-argument'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority,
  registerSshProviderRequestAbort
} from '../../../ssh/connection/authority/ssh-provider-authority'
import { detectRemoteHostPlatform } from '../../../ssh/remote-host/ssh-remote-platform-detection'
import { buildSshLoginShellCommand } from '../../../ssh/remote-exec/ssh-login-shell-command'
import { wrapRemoteCommandForPosixShell } from '../../../ssh/remote-exec/ssh-posix-command-wrapper'
import { powerShellCommand } from '../../../ssh/remote-exec/ssh-remote-powershell'
import { execCommand, isSshCommandExitError } from '../../../ssh/remote-exec/remote-exec-command'
import { fingerprintRuntimeSshTarget } from '../../../ssh/runtime-access/runtime-ssh-target-fingerprint'
import {
  getSshTargetRegistryStore,
  getSshConnectionManager
} from '../../../ssh/targets/ssh-target-registry'
import {
  isManagedOrcadSshTarget,
  isRuntimeOwnedSshTarget
} from '../../../ssh/targets/ssh-target-runtime-ownership'
import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from '../../../text-generation/execution/source-control-generation-limits'
import { discoveredModelsResult } from '../../../text-generation/models/commit-message-model-discovery-policy'
import type { DiscoverCommitMessageModelsResult } from '../../../text-generation/source-control-text-generation-types'

const inFlight = new InFlightPromiseDedupe<DiscoverCommitMessageModelsResult>()
const args = DOUBAO_MODEL_LIST_ARGS.join(' ')
const disconnected = 'Reconnect to the SSH host to discover its Doubao models.'

function windowsModelList(cwd: string): string {
  return powerShellCommand(
    [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$cli = Get-Command doubao -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
      'if (!$cli) { exit 127 }',
      `Set-Location -LiteralPath ${quotePowerShellLiteral(cwd)}`,
      "$env:DOUBAO_CLI_NO_UPDATE_CHECK = '1'",
      `& $cli.Source ${args}`,
      'exit $LASTEXITCODE'
    ].join('\n')
  )
}

/** The caller resolves both arguments from the registered workspace on this SSH host. */
export async function discoverDoubaoSshModels(
  connectionId: string,
  worktreePath: string
): Promise<DiscoverCommitMessageModelsResult> {
  const connection = getSshConnectionManager()?.getConnection(connectionId)
  if (!connection) {
    return { success: false, error: disconnected }
  }
  const target = connection.getTarget()
  if (isManagedOrcadSshTarget(target) || isRuntimeOwnedSshTarget(target)) {
    return {
      success: false,
      error: 'Select the Orca server that owns this SSH host to discover its Doubao models.'
    }
  }
  const registration = fingerprintRuntimeSshTarget(target)
  const generation = connection.getConnectGeneration()
  const authority = getSshProviderAuthority(connectionId)
  const current = (): boolean => {
    const stored = getSshTargetRegistryStore()?.getTarget(connectionId)
    return Boolean(
      stored &&
      stored.id === target.id &&
      !isManagedOrcadSshTarget(stored) &&
      !isRuntimeOwnedSshTarget(stored) &&
      stored.generation === target.generation &&
      fingerprintRuntimeSshTarget(stored) === registration &&
      getSshConnectionManager()?.getConnection(connectionId) === connection &&
      connection.getState().status === 'connected' &&
      connection.getConnectGeneration() === generation &&
      isCurrentSshProviderAuthority(authority)
    )
  }
  if (!current()) {
    return { success: false, error: disconnected }
  }
  return inFlight.run(
    JSON.stringify([authority, registration, generation, worktreePath]),
    async () => {
      if (!current()) {
        return { success: false, error: disconnected }
      }
      const controller = new AbortController()
      const unregister = registerSshProviderRequestAbort(authority, controller)
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
      const options = { signal, maxOutputBytes: MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES }
      try {
        const os =
          connection.getState().remotePlatform ??
          (await detectRemoteHostPlatform(connection, { signal }))?.os
        if (
          !os ||
          !(os === 'win32'
            ? isWindowsAbsolutePathLike(worktreePath)
            : posix.isAbsolute(worktreePath)) ||
          worktreePath.includes('\0')
        ) {
          return {
            success: false,
            error: 'Could not determine the remote workspace path or platform.'
          }
        }
        if (!current()) {
          return { success: false, error: disconnected }
        }
        let stdout: string
        if (os === 'win32') {
          stdout = await execCommand(connection, windowsModelList(worktreePath), {
            ...options,
            wrapCommand: false
          })
        } else {
          const shell = (
            await execCommand(connection, 'printf %s "${SHELL:-/bin/sh}"', options)
          ).trim()
          if (!current()) {
            return { success: false, error: disconnected }
          }
          // Resolve before entering the workspace so a relative PATH entry cannot select its files.
          const command = [
            'cli=$(command -v doubao) || exit 127',
            'case "$cli" in /*) ;; *) exit 127 ;; esac',
            `cd ${quotePosixShell(worktreePath)} && DOUBAO_CLI_NO_UPDATE_CHECK=1 "$cli" ${args}`
          ].join('\n')
          const probe = buildSshLoginShellCommand(
            shell,
            wrapRemoteCommandForPosixShell(command, { compress: false })
          )
          stdout = probe.readStdout(await execCommand(connection, probe.command, options)) ?? ''
        }
        if (!current()) {
          return { success: false, error: disconnected }
        }
        return discoveredModelsResult(
          getAgentModelProbeSpec('doubao')!,
          parseDoubaoModelList(stdout)
        )
      } catch (error) {
        if (!current()) {
          return { success: false, error: disconnected }
        }
        if (isSshCommandExitError(error) && error.exitCode === 127) {
          return {
            success: false,
            unavailable: { reason: 'cliMissing' },
            error: 'Doubao was not found on the SSH host’s PATH.'
          }
        }
        return {
          success: false,
          error: signal.aborted
            ? 'Doubao model discovery on the SSH host timed out.'
            : 'Could not list Doubao models on the SSH host. Check the remote CLI and its sign-in.'
        }
      } finally {
        unregister()
      }
    }
  )
}
