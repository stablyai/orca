import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { defineStreamingMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import { bindStructuredAgentSessionStream } from '../subscriptions/structured-agent-session-status-stream'
import {
  AGENT_SESSION_SHELL_COMMAND_MAX_OUTPUT_BYTES,
  AGENT_SESSION_SHELL_COMMAND_TIMEOUT_MS,
  ShellCommandParams,
  type AgentSessionShellCommandFrame
} from '../../../../../../shared/rpc-contract/structured-agent-session-shell-command-params'
import { resolveAgentSessionLaunchDirectory } from '../../../../agent-session/agent-session-launch-directory'
import {
  hostShellEnvironment,
  resolveHostAgentBaseEnvironment
} from '../../../../agent-session/environment/structured-agent-shell-environment'
import { resolvePtyShellPath } from '../../../../../daemon/shell-readiness/shell-ready'
import {
  SHELL_COMMAND_CWD_FILE_ENV,
  shellCommandInvocation
} from './structured-agent-session-shell-invocation'
import { createShellOutputStream, shellOutputTail } from './structured-agent-session-shell-output'
import {
  rememberShellDirectory,
  shellDirectoryLabel,
  shellStartDirectory
} from './structured-agent-session-shell-directory'

export const STRUCTURED_AGENT_SESSION_SHELL_COMMAND_METHODS = [
  defineStreamingMethod({
    name: 'agentSession.runShellCommand',
    permission: 'workspace',
    params: ShellCommandParams,
    handler: async (params, ctx, emit) => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      const { store, resolveWorkspacePath } = host.deps
      if (!resolveWorkspacePath) {
        throw new Error('The chat workspace is unavailable on this host.')
      }
      const record = store.requireWritableRecord(params.sessionId)
      const root = await resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath }, record)
      const cwd = await shellStartDirectory(params.sessionId, root)
      const [shellEnv, env, directory] = await Promise.all([
        hostShellEnvironment(),
        resolveHostAgentBaseEnvironment(ctx.runtime.requireStore().getSettings()),
        shellDirectoryLabel(root, cwd)
      ])
      const program = resolvePtyShellPath({
        SHELL: shellEnv.SHELL ?? '',
        ORCA_TERMINAL_WINDOWS_SHELL: shellEnv.ORCA_TERMINAL_WINDOWS_SHELL ?? ''
      })
      const {
        capturesCwd,
        env: invocationEnv,
        ...invocation
      } = shellCommandInvocation(program, params.command)
      const cwdFile = capturesCwd ? join(tmpdir(), `orca-shell-cwd-${randomUUID()}`) : null

      const abort = new AbortController()
      const subscriptionId = `agentSession.shell:${ctx.connectionId ?? 'local'}:${ctx.requestId ?? randomUUID()}`
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => abort.abort())
      if (stream.isClosed()) {
        return
      }
      const send = (frame: AgentSessionShellCommandFrame): void => {
        if (!stream.isClosed()) {
          emit(frame)
        }
      }
      send({ type: 'started', directory })
      const output = createShellOutputStream(
        (chunks) => send({ type: 'output', chunks }),
        AGENT_SESSION_SHELL_COMMAND_MAX_OUTPUT_BYTES * 2
      )
      void runProcess(
        {
          program,
          ...invocation,
          cwd,
          env: {
            ...env,
            ...invocationEnv,
            PWD: cwd,
            ...(cwdFile ? { [SHELL_COMMAND_CWD_FILE_ENV]: cwdFile } : {})
          },
          timeoutMs: AGENT_SESSION_SHELL_COMMAND_TIMEOUT_MS,
          maxOutputBytes: AGENT_SESSION_SHELL_COMMAND_MAX_OUTPUT_BYTES,
          signal: abort.signal,
          terminationBarrier: true,
          onStdout: (chunk) => output.push('stdout', chunk),
          onStderr: (chunk) => output.push('stderr', chunk)
        },
        'tail'
      ).then(
        async (result) => {
          const { overflowed } = output.finish()
          if (cwdFile) {
            await rememberShellDirectory(params.sessionId, root, cwdFile)
          }
          send({
            type: 'exit',
            exitCode: result.code,
            timedOut: result.timedOut,
            outputTruncated: overflowed,
            ...(overflowed
              ? {
                  output: shellOutputTail(
                    result.stdout,
                    result.stderr,
                    AGENT_SESSION_SHELL_COMMAND_MAX_OUTPUT_BYTES
                  )
                }
              : {})
          })
        },
        async (error: unknown) => {
          output.finish()
          if (cwdFile) {
            await rm(cwdFile, { force: true }).catch(() => {})
          }
          send({
            type: 'exit',
            exitCode: null,
            timedOut: false,
            outputTruncated: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      )
    }
  })
]
