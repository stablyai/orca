// What this computer already uses to sign agents in, so an Orca Cloud workspace can start with the
// same credentials. API keys are offered for the cloud secret store, where the egress proxy swaps
// them in (the VM only ever holds a placeholder). OAuth/subscription sign-ins are never copied:
// they can't be swapped, and the user signs in once on the workspace instead.
import { constants } from 'node:fs'
import { access, open, stat, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseDotenvPaste } from '../../shared/cloud-secrets/dotenv-paste'

/** Names the egress proxy swaps (cloud/apps/sandbox-control/src/provider-env.ts), per agent that reads them. */
export const SWAPPABLE_AGENT_KEY_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'CURSOR_API_KEY',
  'AI_GATEWAY_API_KEY'
] as const
export type SwappableAgentKeyName = (typeof SWAPPABLE_AGENT_KEY_NAMES)[number]

/** OpenCode auth.json provider id -> the env name OpenCode also reads for that provider. */
const OPENCODE_PROVIDER_ENV: Record<string, SwappableAgentKeyName> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  vercel: 'AI_GATEWAY_API_KEY'
}

export type LocalAgentKey = {
  name: SwappableAgentKeyName
  value: string
  /** Where it was found, for the confirmation copy (never the value). */
  source: 'opencode-auth' | 'gemini-env-file' | 'shell-env'
}

/** A sign-in that stays on this computer; the user signs in on the workspace instead. */
export type LocalAgentSignIn = {
  agent: 'opencode' | 'gemini'
  /** Provider (OpenCode) or method (Gemini) the sign-in is for. */
  provider: string
}

export type LocalAgentCredentials = {
  keys: LocalAgentKey[]
  signIns: LocalAgentSignIn[]
}

type Sources = {
  home: string
  env: Readonly<Record<string, string | undefined>>
  readText: (path: string) => Promise<string | null>
  /** Sign-in files are only checked for, never read. */
  exists: (path: string) => Promise<boolean>
}

/** Agent credential files are small; anything bigger isn't one. */
const MAX_FILE_BYTES = 256 * 1024

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** A regular file under the cap, read without blocking on a FIFO or following it into a device. */
async function defaultReadText(path: string): Promise<string | null> {
  let handle: FileHandle | null = null
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      return null
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES) {
      return null
    }
    return await handle.readFile('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function usable(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length >= 8 &&
    value.length <= 16 * 1024 &&
    !/\s/.test(value.trim())
  )
}

/**
 * First source wins per name: OpenCode's own auth file, then Gemini's ~/.gemini/.env, then the login
 * shell's env (what an agent started from a terminal here would see).
 */
export async function readLocalAgentCredentials(
  sources: Partial<Sources> = {}
): Promise<LocalAgentCredentials> {
  const home = sources.home ?? homedir()
  const env = sources.env ?? process.env
  const readText = sources.readText ?? defaultReadText
  const exists = sources.exists ?? defaultExists
  const keys = new Map<SwappableAgentKeyName, LocalAgentKey>()
  const signIns: LocalAgentSignIn[] = []
  const offer = (name: SwappableAgentKeyName, value: unknown, source: LocalAgentKey['source']) => {
    if (!keys.has(name) && usable(value)) {
      keys.set(name, { name, value: value.trim(), source })
    }
  }

  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  const opencode = await readText(join(dataHome, 'opencode', 'auth.json'))
  if (opencode) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(opencode)
    } catch {
      // A file OpenCode can't read either; nothing to offer.
    }
    if (isRecord(parsed)) {
      for (const [provider, entry] of Object.entries(parsed)) {
        if (!isRecord(entry)) {
          continue
        }
        const name = OPENCODE_PROVIDER_ENV[provider]
        if (entry.type === 'api' && name) {
          offer(name, entry.key, 'opencode-auth')
        } else if (entry.type === 'oauth' || entry.type === 'wellknown') {
          signIns.push({ agent: 'opencode', provider })
        }
      }
    }
  }

  const geminiEnv = await readText(join(home, '.gemini', '.env'))
  if (geminiEnv) {
    for (const entry of parseDotenvPaste(geminiEnv)) {
      if (entry.name === 'GEMINI_API_KEY' || entry.name === 'GOOGLE_GENERATIVE_AI_API_KEY') {
        offer(entry.name, entry.value, 'gemini-env-file')
      }
    }
  }
  if (await exists(join(home, '.gemini', 'oauth_creds.json'))) {
    signIns.push({ agent: 'gemini', provider: 'google' })
  }

  for (const name of SWAPPABLE_AGENT_KEY_NAMES) {
    offer(name, env[name], 'shell-env')
  }
  return { keys: [...keys.values()], signIns }
}
