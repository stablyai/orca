import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  open as openFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

const AUTH_FILE = 'auth.json'
const CONFIG_FILE = 'config.toml'
const MAX_AUTH_BYTES = 1024 * 1024
const STRUCTURED_WRITER_CONFIG = 'web_search = "disabled"\nmcp_servers = {}\n'

type HomeGeneration = { generation: number; path: string | null }

/**
 * Builds a credential-only Codex home for one App Server child. User config,
 * plugins, skills, hooks, memories, and MCP definitions never cross into it.
 */
export class CodexStructuredHomeIsolation {
  private readonly homes = new Map<string, HomeGeneration>()
  private readonly issuedHomes = new Set<string>()

  private constructor(private readonly root: string) {}

  static async open(parent: string): Promise<CodexStructuredHomeIsolation> {
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const canonicalParent = await realpath(parent)
    await removeStaleProcessHomes(canonicalParent)
    const root = await mkdtemp(join(canonicalParent, `process-${process.pid}-`))
    return new CodexStructuredHomeIsolation(await realpath(root))
  }

  async prepare(sessionId: string, sourceHome: string): Promise<string> {
    const generation = (this.homes.get(sessionId)?.generation ?? 0) + 1
    this.homes.set(sessionId, { generation, path: null })
    let auth: Buffer | null = null
    let isolatedHome: string | null = null
    try {
      auth = await readAuthentication(sourceHome)
      const prefix = `${sha256(sessionId).slice(0, 16)}-${randomBytes(8).toString('hex')}-`
      isolatedHome = await mkdtemp(join(this.root, prefix))
      this.issuedHomes.add(isolatedHome)
      await writeFile(join(isolatedHome, AUTH_FILE), auth, { flag: 'wx', mode: 0o600 })
      await writeFile(join(isolatedHome, CONFIG_FILE), STRUCTURED_WRITER_CONFIG, {
        flag: 'wx',
        mode: 0o600
      })
      const current = this.homes.get(sessionId)
      if (!current || current.generation !== generation) {
        throw new Error('structured Codex home preparation was superseded')
      }
      current.path = isolatedHome
      return isolatedHome
    } catch (error) {
      if (isolatedHome) {
        this.issuedHomes.delete(isolatedHome)
        await rm(isolatedHome, { recursive: true, force: true })
      }
      if (this.homes.get(sessionId)?.generation === generation) {
        this.homes.delete(sessionId)
      }
      throw error
    } finally {
      auth?.fill(0)
    }
  }

  async release(sessionId: string, isolatedHome: string): Promise<void> {
    if (!this.issuedHomes.delete(isolatedHome)) {
      return
    }
    if (dirname(isolatedHome) !== this.root) {
      throw new Error('structured Codex home release escaped the isolation root')
    }
    const current = this.homes.get(sessionId)
    if (current?.path === isolatedHome) {
      this.homes.delete(sessionId)
    }
    await rm(isolatedHome, { recursive: true, force: true })
  }

  async close(): Promise<void> {
    this.homes.clear()
    this.issuedHomes.clear()
    await rm(this.root, { recursive: true, force: true })
  }
}

async function removeStaleProcessHomes(parent: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true })
  for (const entry of entries) {
    const match = entry.isDirectory() ? /^process-(\d+)-/.exec(entry.name) : null
    if (!match || isProcessAlive(Number(match[1]))) {
      continue
    }
    await rm(join(parent, entry.name), { recursive: true, force: true })
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return true
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function readAuthentication(sourceHome: string): Promise<Buffer> {
  const sourceRoot = await realpath(sourceHome)
  const sourceAuth = join(sourceRoot, AUTH_FILE)
  let handle
  try {
    handle = await openFile(sourceAuth, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (cause) {
    throw new Error('structured Codex authentication source is not a regular file', { cause })
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new Error('structured Codex authentication source is not a regular file')
    }
    if (metadata.size <= 0 || metadata.size > MAX_AUTH_BYTES) {
      throw new Error('structured Codex authentication source has an invalid size')
    }
    const auth = await handle.readFile()
    if (auth.length <= 0 || auth.length > MAX_AUTH_BYTES) {
      auth.fill(0)
      throw new Error('structured Codex authentication source changed to an invalid size')
    }
    return auth
  } finally {
    await handle.close()
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
