import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ownerToken = randomUUID()
const OWNER_FILE_PATTERN = /^owner-([\da-f-]{36})\.json$/i

type GrokHookOwner = { token: string; pid: number }

function ownerDirectory(): string {
  return join(homedir(), '.orca', 'agent-hooks', 'grok-owners')
}

function ownerPath(directory = ownerDirectory()): string {
  return join(directory, `owner-${ownerToken}.json`)
}

export function registerGrokHookOwner(): void {
  const directory = ownerDirectory()
  mkdirSync(directory, { recursive: true })
  try {
    writeFileSync(
      ownerPath(directory),
      `${JSON.stringify({ token: ownerToken, pid: process.pid } satisfies GrokHookOwner)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
}

export function unregisterGrokHookOwnerSync(): void {
  rmSync(ownerPath(), { force: true })
}

export async function releaseGrokHookOwnerAndCheckForPeers(): Promise<boolean> {
  const directory = ownerDirectory()
  await rm(ownerPath(directory), { force: true })
  return await hasLivePeer(directory, ownerToken, probeProcess)
}

/** Fast second check after liveness pruning closes the registration race before cleanup commits. */
export async function hasRegisteredGrokHookOwner(directory = ownerDirectory()): Promise<boolean> {
  try {
    return (await readdir(directory)).some((entry) => OWNER_FILE_PATTERN.test(entry))
  } catch (error) {
    // Why: unverifiable ownership must preserve the shared hook, never delete it.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

export async function hasLivePeer(
  directory: string,
  currentToken: string,
  probe: (pid: number) => Promise<boolean | undefined>
): Promise<boolean> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    // Why: unverifiable ownership must preserve the shared hook, never delete it.
    return true
  }

  for (const entry of entries) {
    const token = OWNER_FILE_PATTERN.exec(entry)?.[1]
    if (!token || token === currentToken) {
      continue
    }
    const path = join(directory, entry)
    let owner: GrokHookOwner | null = null
    try {
      const candidate = JSON.parse(await readFile(path, 'utf8')) as Partial<GrokHookOwner>
      if (
        candidate.token === token &&
        Number.isSafeInteger(candidate.pid) &&
        (candidate.pid ?? 0) > 0
      ) {
        owner = candidate as GrokHookOwner
      }
    } catch {
      // Invalid Orca-owned records cannot prove a live peer and are pruned below.
    }
    if (!owner) {
      await rm(path, { force: true })
      continue
    }
    const live = await probe(owner.pid)
    if (live === false) {
      await rm(path, { force: true })
      continue
    }
    // true proves liveness; undefined means the platform could not prove death.
    return true
  }
  return false
}

async function probeProcess(pid: number): Promise<boolean | undefined> {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined
  }
}
