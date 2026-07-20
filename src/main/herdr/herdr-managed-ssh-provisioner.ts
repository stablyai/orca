import { join } from 'node:path'
import type { SshConnection } from '../ssh/ssh-connection'
import {
  makeRemoteDirectoryCommand,
  makeRemoteExecutableCommand,
  readRemoteHomeCommand
} from '../ssh/ssh-remote-commands'
import { detectRemoteHostPlatform } from '../ssh/ssh-remote-platform-detection'
import { joinRemotePath, normalizeRemoteHome, validateRemoteHome } from '../ssh/ssh-remote-platform'
import { HerdrRuntimeError } from './herdr-runtime-contract'
import { verifyManagedHerdrExecutable } from './herdr-binary-source'

const MANAGED_HERDR_SSH_COMMAND_TIMEOUT_MS = 15_000

async function runRemoteCommand(connection: SshConnection, command: string): Promise<string> {
  const channel = await connection.exec(command)
  return await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      callback()
    }
    const timeout = setTimeout(() => {
      finish(() => {
        channel.close()
        reject(
          new Error(
            `Remote Herdr provisioning command timed out after ${MANAGED_HERDR_SSH_COMMAND_TIMEOUT_MS}ms`
          )
        )
      })
    }, MANAGED_HERDR_SSH_COMMAND_TIMEOUT_MS)
    channel.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    channel.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    channel.once('error', (error) => finish(() => reject(error)))
    channel.once('close', (code: number) => {
      if (code === 0) {
        finish(() => resolve(stdout))
      } else {
        finish(() => reject(new Error(stderr.trim() || `Remote command exited with code ${code}`)))
      }
    })
  })
}

async function uploadDistribution(
  connection: SshConnection,
  localDirectory: string,
  remoteDirectory: string,
  executableName: string,
  hostPlatform: Awaited<ReturnType<typeof detectRemoteHostPlatform>>
): Promise<void> {
  if (!hostPlatform) {
    throw new Error('Remote platform is unavailable')
  }
  const upload = await connection.openFileUploadSession({ hostPlatform })
  try {
    await upload.uploadFile(
      join(localDirectory, executableName),
      joinRemotePath(hostPlatform, remoteDirectory, executableName)
    )
    await upload.uploadFile(
      join(localDirectory, 'manifest.json'),
      joinRemotePath(hostPlatform, remoteDirectory, 'manifest.json')
    )
    await upload.uploadFile(
      join(localDirectory, 'LICENSE'),
      joinRemotePath(hostPlatform, remoteDirectory, 'LICENSE')
    )
  } finally {
    upload.close()
  }
}

export async function ensureManagedHerdrOnSsh(
  connection: SshConnection,
  resourcesPath: string
): Promise<string> {
  try {
    const hostPlatform = await detectRemoteHostPlatform(connection)
    if (!hostPlatform) {
      throw new Error('remote OS or architecture is unsupported')
    }
    const executableName = hostPlatform.os === 'win32' ? 'herdr.exe' : 'herdr'
    const localDirectory = join(resourcesPath, 'herdr', hostPlatform.relayPlatform)
    const localExecutable = join(localDirectory, executableName)
    const manifest = verifyManagedHerdrExecutable(localExecutable, hostPlatform.os)
    const remoteHome = normalizeRemoteHome(
      await runRemoteCommand(connection, readRemoteHomeCommand(hostPlatform)),
      hostPlatform
    )
    if (!validateRemoteHome(remoteHome, hostPlatform)) {
      throw new Error('remote home is invalid')
    }
    const remoteDirectory = joinRemotePath(
      hostPlatform,
      remoteHome,
      '.orca-remote',
      'herdr',
      manifest.sourceCommit
    )
    await runRemoteCommand(connection, makeRemoteDirectoryCommand(hostPlatform, remoteDirectory))
    await uploadDistribution(
      connection,
      localDirectory,
      remoteDirectory,
      executableName,
      hostPlatform
    )
    const remoteExecutable = joinRemotePath(hostPlatform, remoteDirectory, executableName)
    await runRemoteCommand(connection, makeRemoteExecutableCommand(hostPlatform, remoteExecutable))
    return remoteExecutable
  } catch (error) {
    throw new HerdrRuntimeError(
      'herdr_unavailable',
      `Managed Herdr SSH provisioning failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
