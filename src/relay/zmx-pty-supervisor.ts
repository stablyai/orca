import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const METADATA_VERSION = 1
const PTY_ID_PATTERN = /^pty-\d+$/

import type { AgentSessionOwnerBinding } from '../shared/agent-session-host-authority'

export type ZmxPtySessionMetadata = {
  version: typeof METADATA_VERSION
  id: string
  incarnationId: string
  initialCwd: string
  cols: number
  rows: number
  shell: string
  paneKey?: string
  tabId?: string
  attachIdentity?: { paneKey?: string; tabId?: string }
  worktreeId?: string
  terminalHandle?: string
  explicitTerm?: string
  envToDelete: string[]
  gitCredentialPromptGuarded: boolean
  createdAt: number
  /** Live agent-session owner bindings; restored so a replacement relay
   *  re-adopts the running agent instead of minting a duplicate owner. */
  agentSessionOwners?: AgentSessionOwnerBinding[]
}

export type ZmxSessionInfo = {
  id: string
  pid: number
  cwd?: string
  command?: string
}

type ZmxSupervisorOptions = {
  executablePath: string
  namespace: string
  storageRoot?: string
}

function isMetadata(value: unknown): value is ZmxPtySessionMetadata {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const input = value as Record<string, unknown>
  const optionalString = (field: unknown): boolean =>
    field === undefined || typeof field === 'string'
  const optionalAttachIdentity = (field: unknown): boolean =>
    field === undefined ||
    (typeof field === 'object' &&
      field !== null &&
      !Array.isArray(field) &&
      optionalString((field as Record<string, unknown>).paneKey) &&
      optionalString((field as Record<string, unknown>).tabId))
  return (
    input.version === METADATA_VERSION &&
    typeof input.id === 'string' &&
    PTY_ID_PATTERN.test(input.id) &&
    typeof input.incarnationId === 'string' &&
    typeof input.initialCwd === 'string' &&
    Number.isInteger(input.cols) &&
    (input.cols as number) > 0 &&
    Number.isInteger(input.rows) &&
    (input.rows as number) > 0 &&
    typeof input.shell === 'string' &&
    Array.isArray(input.envToDelete) &&
    input.envToDelete.every((entry) => typeof entry === 'string') &&
    typeof input.gitCredentialPromptGuarded === 'boolean' &&
    typeof input.createdAt === 'number' &&
    // Why: recovery and shutdown sweeps dereference these without re-checking;
    // a same-user-corrupted file must fail validation, not throw mid-sweep.
    optionalString(input.paneKey) &&
    optionalString(input.tabId) &&
    optionalAttachIdentity(input.attachIdentity) &&
    optionalString(input.worktreeId) &&
    optionalString(input.terminalHandle) &&
    optionalString(input.explicitTerm) &&
    (input.agentSessionOwners === undefined ||
      (Array.isArray(input.agentSessionOwners) &&
        input.agentSessionOwners.every((owner) => typeof owner === 'object' && owner !== null)))
  )
}

function parseSessionLine(id: string, line: string): ZmxSessionInfo | null {
  if (!line.startsWith(`session_name=${id}\t`)) {
    return null
  }
  const pid = Number.parseInt(line.match(/(?:^|\t)pid=(\d+)/)?.[1] ?? '', 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null
  }
  return {
    id,
    pid,
    cwd: line.match(/(?:^|\t)started_in=([^\t]*)/)?.[1],
    command: line.match(/(?:^|\t)cmd=([^\t]*)/)?.[1]
  }
}

export class ZmxPtySupervisor {
  readonly executablePath: string
  readonly runtimeDir: string
  private readonly metadataDir: string

  constructor({ executablePath, namespace, storageRoot }: ZmxSupervisorOptions) {
    if (!executablePath || !namespace) {
      throw new Error('zmx PTY supervision requires an executable and namespace')
    }
    const root = storageRoot ?? join(homedir(), '.orca-remote', 'zmx-pty', namespace)
    this.executablePath = executablePath
    this.runtimeDir = join(root, 'runtime')
    this.metadataDir = join(root, 'metadata')
  }

  async prepare(): Promise<void> {
    await Promise.all([
      mkdir(this.runtimeDir, { recursive: true, mode: 0o700 }),
      mkdir(this.metadataDir, { recursive: true, mode: 0o700 })
    ])
  }

  spawnEnvironment(base: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = { ...base, ZMX_DIR: this.runtimeDir }
    delete env.ZMX_SESSION
    return env
  }

  private controlEnvironment(sessionId?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ZMX_DIR: this.runtimeDir }
    if (sessionId) {
      env.ZMX_SESSION = sessionId
    } else {
      delete env.ZMX_SESSION
    }
    return env
  }

  newSessionArgs(id: string, shell: string, shellArgs: readonly string[]): string[] {
    this.assertSessionId(id)
    return ['attach', id, shell, ...shellArgs]
  }

  attachArgs(id: string): string[] {
    this.assertSessionId(id)
    return ['attach', id]
  }

  async writeMetadata(metadata: ZmxPtySessionMetadata): Promise<void> {
    this.assertSessionId(metadata.id)
    await this.prepare()
    const destination = this.metadataPath(metadata.id)
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, destination)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  async readMetadata(id: string): Promise<ZmxPtySessionMetadata | null> {
    this.assertSessionId(id)
    try {
      const parsed: unknown = JSON.parse(await readFile(this.metadataPath(id), 'utf8'))
      return isMetadata(parsed) && parsed.id === id ? parsed : null
    } catch {
      return null
    }
  }

  async listMetadata(): Promise<ZmxPtySessionMetadata[]> {
    await this.prepare()
    const entries = await readdir(this.metadataDir, { withFileTypes: true })
    const metadata = await Promise.all(
      entries
        // Why: a foreign .json in the metadata dir must be ignored, not throw —
        // one stray file would otherwise wedge every listing and recovery sweep.
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith('.json') &&
            PTY_ID_PATTERN.test(basename(entry.name, '.json'))
        )
        .map((entry) => this.readMetadata(basename(entry.name, '.json')))
    )
    return metadata.filter((entry): entry is ZmxPtySessionMetadata => entry !== null)
  }

  async removeMetadata(id: string): Promise<void> {
    this.assertSessionId(id)
    await unlink(this.metadataPath(id)).catch(() => {})
  }

  async listSessionNames(): Promise<string[]> {
    const output = await this.run(['list', '--short'])
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => PTY_ID_PATTERN.test(line))
  }

  async sessionInfo(id: string): Promise<ZmxSessionInfo | null> {
    this.assertSessionId(id)
    const output = await this.run(['list'])
    for (const line of output.split(/\r?\n/)) {
      const info = parseSessionLine(id, line.trimStart())
      if (info) {
        return info
      }
    }
    return null
  }

  async waitForSession(id: string, timeoutMs = 2_000): Promise<ZmxSessionInfo | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const info = await this.sessionInfo(id)
      if (info) {
        return info
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return null
  }

  async killSession(id: string): Promise<void> {
    this.assertSessionId(id)
    await this.run(['kill', id])
    await this.removeMetadata(id)
  }

  async detachClients(id: string): Promise<void> {
    this.assertSessionId(id)
    await this.run(['detach'], id)
  }

  private async run(args: string[], sessionId?: string): Promise<string> {
    await this.prepare()
    return await new Promise((resolve, reject) => {
      execFile(
        this.executablePath,
        args,
        {
          encoding: 'utf8',
          env: this.controlEnvironment(sessionId),
          timeout: 5_000,
          maxBuffer: 1024 * 1024
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                `zmx ${args[0]} failed: ${String(stderr || error.message).trim() || 'unknown error'}`
              )
            )
            return
          }
          resolve(stdout)
        }
      )
    })
  }

  private metadataPath(id: string): string {
    return join(this.metadataDir, `${id}.json`)
  }

  private assertSessionId(id: string): void {
    if (!PTY_ID_PATTERN.test(id)) {
      throw new Error(`Invalid zmx PTY session id: ${id}`)
    }
  }
}
