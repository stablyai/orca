import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PI_DRAFT_BRIDGE_PROTOCOL,
  PiDraftBridgeSessionSchema,
  type PiDraftBridgeSession
} from './draft-bridge-protocol'
import {
  ORCA_PI_DRAFT_BRIDGE_DIR_ENV,
  ORCA_PI_DRAFT_BRIDGE_TOKEN_ENV
} from './draft-bridge-extension-source'

const PI_DRAFT_BRIDGE_ROOT = 'pi-draft-bridge'

export type PiDraftBridgePaths = {
  dir: string
  session: PiDraftBridgeSession
}

/** One directory per PTY: a reused handle cannot inherit a prior process's bridge. */
export function getPiDraftBridgeDir(userDataPath: string, ptyId: string): string {
  const key = createHash('sha256').update(ptyId).digest('hex').slice(0, 32)
  return join(userDataPath, PI_DRAFT_BRIDGE_ROOT, key)
}

/** Called once per spawn, before the agent starts, so only this process can answer the directory. */
export function preparePiDraftBridge(
  userDataPath: string,
  ptyId: string,
  paneKey: string
): PiDraftBridgePaths {
  const dir = getPiDraftBridgeDir(userDataPath, ptyId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const file of ['request.json', 'response.json', 'hello.json']) {
    rmSync(join(dir, file), { force: true })
  }
  const session = {
    protocol: PI_DRAFT_BRIDGE_PROTOCOL,
    token: randomUUID(),
    paneKey,
    createdAt: Date.now()
  }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session), { mode: 0o600 })
  return { dir, session }
}

export function readPiDraftBridgeSession(
  userDataPath: string,
  ptyId: string
): PiDraftBridgePaths | null {
  const dir = getPiDraftBridgeDir(userDataPath, ptyId)
  try {
    const parsed = PiDraftBridgeSessionSchema.safeParse(
      JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'))
    )
    return parsed.success ? { dir, session: parsed.data } : null
  } catch {
    return null
  }
}

export function buildPiDraftBridgeEnv(paths: PiDraftBridgePaths): Record<string, string> {
  return {
    [ORCA_PI_DRAFT_BRIDGE_DIR_ENV]: paths.dir,
    [ORCA_PI_DRAFT_BRIDGE_TOKEN_ENV]: paths.session.token
  }
}

export function clearPiDraftBridge(userDataPath: string, ptyId: string): void {
  rmSync(getPiDraftBridgeDir(userDataPath, ptyId), { recursive: true, force: true })
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Why: EPERM means the process exists but belongs to another security context.
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}

export function piDraftBridgeHelloExists(dir: string): boolean {
  return existsSync(join(dir, 'hello.json'))
}
