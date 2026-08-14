import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Why: the opencode2 daemon registers at <XDG state>/opencode/service.json, the
// same contract as the v2 client's Service.discover; electron-free for tests.
// See ADR 0002.

export type OpenCode2ServiceInfo = {
  id?: string
  version?: string
  url: string
  pid?: number
  password?: string
}

export function resolveOpenCode2ServiceInfoPath(): string {
  const stateHome =
    process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim().length > 0
      ? process.env.XDG_STATE_HOME.trim()
      : process.platform === 'win32' && process.env.LOCALAPPDATA
        ? process.env.LOCALAPPDATA
        : join(homedir(), '.local', 'state')
  return join(stateHome, 'opencode', 'service.json')
}

export function readOpenCode2ServiceInfo(pathOverride?: string): OpenCode2ServiceInfo | null {
  const servicePath = pathOverride ?? resolveOpenCode2ServiceInfoPath()
  try {
    if (!existsSync(servicePath)) {
      return null
    }
    const parsed = JSON.parse(readFileSync(servicePath, 'utf8')) as Partial<OpenCode2ServiceInfo>
    if (typeof parsed.url !== 'string' || parsed.url.trim().length === 0) {
      return null
    }
    return {
      ...(typeof parsed.id === 'string' ? { id: parsed.id } : {}),
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      url: parsed.url.trim(),
      ...(typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? { pid: parsed.pid } : {}),
      ...(typeof parsed.password === 'string' && parsed.password.trim().length > 0
        ? { password: parsed.password }
        : {})
    }
  } catch {
    return null
  }
}

/** Basic-auth headers matching the v2 client contract (username `opencode`). */
export function buildOpenCode2AuthHeaders(info: OpenCode2ServiceInfo): Record<string, string> {
  if (!info.password) {
    return {}
  }
  return {
    Authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString('base64')}`
  }
}
