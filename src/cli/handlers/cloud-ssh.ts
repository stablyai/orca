import { connect } from 'node:net'
import { spawnProcess } from '@orca/process-host'
import {
  CLOUD_SSH_PREPARE_METHOD,
  CLOUD_SSH_TUNNEL_METHOD,
  type CloudSshPrepareResult,
  type CloudSshTunnelResult
} from '../../shared/cloud-ssh'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'
import { quoteCliCommandArgument } from '../shell-command-quote'

/** A cold workspace wakes in ~5-15 s; leave room for a slow resume before giving up. */
const CLOUD_SSH_CALL_TIMEOUT_MS = 180_000
const APP_START_TIMEOUT_MS = 30_000

/** Calls the desktop, starting it first when it is not running (ssh may run with no app open). */
async function callDesktop<T extends { ok: boolean }>(
  client: HandlerContext['client'],
  method: string,
  workspace: string
): Promise<T> {
  const call = async (): Promise<T> =>
    (await client.call<T>(method, { workspace }, { timeoutMs: CLOUD_SSH_CALL_TIMEOUT_MS })).result
  try {
    return await call()
  } catch (error) {
    if (
      !(error instanceof RuntimeClientError) ||
      error instanceof RuntimeRpcFailureError ||
      error.code !== 'runtime_unavailable'
    ) {
      throw error
    }
    process.stderr.write('orca: starting Orca to reach the workspace…\n')
    await client.openOrca(APP_START_TIMEOUT_MS)
    return call()
  }
}

function refuse(result: { ok: false; code: string; message: string }): never {
  throw new RuntimeClientError(`cloud_ssh_${result.code}`, result.message)
}

/** Pipes this process's stdio to the forward until either side closes. */
function pipeToPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setNoDelay(true)
    socket.once('connect', () => {
      process.stdin.pipe(socket)
      socket.pipe(process.stdout)
    })
    socket.once('error', (error) =>
      reject(new RuntimeClientError('cloud_ssh_forward_failed', error.message))
    )
    socket.once('close', () => resolve())
  })
}

export const CLOUD_SSH_HANDLERS: Record<string, CommandHandler> = {
  'ssh-proxy': async ({ flags, client }) => {
    const workspace = getRequiredStringFlag(flags, 'workspace')
    const result = await callDesktop<CloudSshTunnelResult>(
      client,
      CLOUD_SSH_TUNNEL_METHOD,
      workspace
    )
    if (!result.ok) {
      refuse(result)
    }
    await pipeToPort(result.port)
    // stdin keeps the loop alive after ssh's connection ends; exit once stdout has flushed.
    process.stdout.end(() => process.exit(0))
  },

  ssh: async ({ flags, client, json }) => {
    const workspace = getRequiredStringFlag(flags, 'workspace')
    const result = await callDesktop<CloudSshPrepareResult>(
      client,
      CLOUD_SSH_PREPARE_METHOD,
      workspace
    )
    if (!result.ok) {
      refuse(result)
    }
    const command = getOptionalStringFlag(flags, 'command')
    const args = ['-F', result.configFile, result.alias]
    if (command) {
      args.push(command)
    }
    if (flags.get('print') === true) {
      const printed = command
        ? `${result.command} ${quoteCliCommandArgument(command)}`
        : result.command
      console.log(json ? JSON.stringify({ alias: result.alias, command: printed }) : printed)
      return
    }
    const child = spawnProcess({ program: 'ssh', args, stdio: 'inherit' })
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', (error) =>
        reject(
          new RuntimeClientError(
            'cloud_ssh_client_missing',
            `Could not run ssh (${error.message}). Install an OpenSSH client and try again.`
          )
        )
      )
      child.once('exit', (exitCode) => resolve(exitCode ?? 1))
    })
    process.exitCode = code
  }
}
