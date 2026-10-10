import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { runProcess, spawnProcess } from '@orca/process-host'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-exec-command'

export const SSH_EXEC_OUTPUT_CAP_CHARS = 1024 * 1024

class RelayGcShellChannel extends PassThrough implements ClientChannel {
  stdin: this = this
  stdout: this = this
  stderr: PipedChildProcess['stderr']
  server = false as const
  type = 'session' as const
  subtype = 'exec' as const
  incoming: unknown = null
  outgoing: unknown = null
  private readonly exited = Promise.withResolvers<void>()

  constructor(private readonly child: PipedChildProcess) {
    super({ autoDestroy: false, emitClose: false })
    this.stderr = child.stderr
    child.stdout.pipe(this)
    child.stdout.on('error', (error) => this.emit('error', error))
    child.on('error', (error) => {
      this.exited.resolve()
      this.emit('error', error)
    })
    child.on('close', (code) => {
      this.exited.resolve()
      this.emit('close', code)
    })
    child.stdin.end()
  }

  async dispose(): Promise<void> {
    this.close()
    await this.exited.promise
    this.destroy()
  }

  close(): void {
    this.child.kill()
  }

  eof(): void {
    this.end()
  }

  setWindow(): void {
    throw new Error('GC listing does not resize a terminal')
  }

  signal(): void {
    throw new Error('GC listing does not signal a terminal')
  }

  exit(): void {
    throw new Error('GC listing does not set a remote exit status')
  }
}

export async function runCappedRelayGcShellCommand(command: string): Promise<string> {
  let channel: RelayGcShellChannel | undefined
  const connection: Pick<SshConnection, 'exec' | 'usesSystemSshTransport'> = {
    exec: async (shellCommand) => {
      channel = new RelayGcShellChannel(
        spawnProcess({ program: '/bin/sh', args: ['-c', shellCommand] })
      )
      return channel
    },
    usesSystemSshTransport: () => false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand only reads exec and usesSystemSshTransport; both methods are checked above.
  const sshConnection = connection as SshConnection
  try {
    return await execCommand(sshConnection, command)
  } finally {
    await channel?.dispose()
  }
}

export function createRelayGcListingFixture(): {
  root: string
  findCommand: string
  validNames: string[]
  fillValidEntryBoundary: () => void
  dispose: () => void
} {
  const workspace = mkdtempSync(join(tmpdir(), 'orca-relay-gc-scale-'))
  let root = workspace
  try {
    // Long Unicode paths cross the SSH character cap with fewer real directories.
    for (let index = 0; index < 4; index += 1) {
      root = join(root, `gc-context-${index}-ü-${'x'.repeat(150)}`)
      mkdirSync(root)
    }
    const validNames = ['relay-0.1.0+aaa', 'relay-0.1.0+bbb']
    const stageName = (index: number): string =>
      `relay-9.9.9+abc.upload-${String(index).padStart(12, '0')}`
    const stageCount =
      Math.ceil(SSH_EXEC_OUTPUT_CAP_CHARS / (join(root, stageName(0)).length + 1)) + 1
    for (let index = 0; index < stageCount; index += 1) {
      mkdirSync(join(root, stageName(index)))
    }
    for (const name of validNames) {
      mkdirSync(join(root, name))
    }
    mkdirSync(join(root, 'relay-0.1.0+abc.upload-000000000000'))
    mkdirSync(join(root, 'relay-0.1.0+ggg'))
    mkdirSync(join(root, 'orcad-0.1.0+aaa'))
    mkdirSync(join(root, stageName(0), 'relay-0.1.0+ccc'))
    writeFileSync(join(root, 'relay-0.1.0+ddd'), '')
    symlinkSync(join(root, validNames[0]), join(root, 'relay-0.1.0+eee'), 'dir')
    return {
      root,
      findCommand: `find ${shellEscape(root)} -mindepth 1 -maxdepth 1 -type d -name 'relay-*' -print`,
      validNames,
      fillValidEntryBoundary: () => {
        for (let index = 0; index < 63; index += 1) {
          const name = `relay-0.1.0+${index.toString(16)}`
          validNames.push(name)
          mkdirSync(join(root, name))
        }
      },
      dispose: () => rmSync(workspace, { recursive: true, force: true })
    }
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true })
    throw error
  }
}

export async function readUncappedRelayGcPaths(command: string): Promise<string[]> {
  const result = await runProcess({
    program: '/bin/sh',
    args: ['-c', command],
    maxOutputBytes: 4 * SSH_EXEC_OUTPUT_CAP_CHARS
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(`GC fixture enumeration failed: ${result.code}: ${result.stderr}`)
  }
  return result.stdout.trim().split('\n')
}
