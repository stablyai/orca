import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from '../antigravity/antigravity-chat-home'
import { normalizeFsPath } from '../usage/worktree-attribution/usage-path-comparison'

const ANTIGRAVITY_AGY_CHAT_HOME = 'antigravity-agy-chat'
const SYSTEM_DIR = '.system_generated'
const LOGS_DIR = 'logs'
const COMPACT_TRANSCRIPT = 'transcript.jsonl'
const FULL_TRANSCRIPT = 'transcript_full.jsonl'
const YIELD_EVERY_ENTRIES = 50

export type AntigravityTranscriptRef = {
  path: string
  brainDir: string
  appDataDir: string
  conversationId: string
  mtimeMs: number
  size: number
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return normalizeFsPath(await realpath(filePath))
  } catch {
    return normalizeFsPath(filePath)
  }
}

export function resolveAntigravityUsageBrainDirs(options: {
  userDataPath?: string
  homeDir?: string
  wslHomeDirs?: readonly string[]
}): string[] {
  const home = options.homeDir ?? homedir()
  const dirs = [join(home, '.gemini', 'antigravity-cli', 'brain')]
  if (options.userDataPath) {
    for (const folder of [ANTIGRAVITY_AGY_CHAT_HOME, ANTIGRAVITY_CHAT_HOME_FOLDER]) {
      dirs.push(
        join(options.userDataPath, folder, ANTIGRAVITY_ACP_HOME, 'brain'),
        join(options.userDataPath, folder, 'antigravity-cli', 'brain')
      )
    }
  }
  for (const wslHome of options.wslHomeDirs ?? []) {
    dirs.push(join(wslHome, '.gemini', 'antigravity-cli', 'brain'))
  }
  return [...new Set(dirs)]
}

async function pickConversationTranscript(
  brainDir: string,
  conversationId: string
): Promise<AntigravityTranscriptRef | null> {
  const logsDir = join(brainDir, conversationId, SYSTEM_DIR, LOGS_DIR)
  // Prefer compact transcript.jsonl: tool outputs are capped while PLANNER_RESPONSE counters stay intact.
  for (const fileName of [COMPACT_TRANSCRIPT, FULL_TRANSCRIPT]) {
    const candidate = join(logsDir, fileName)
    try {
      const info = await stat(candidate)
      if (info.isFile()) {
        return {
          path: candidate,
          brainDir,
          appDataDir: dirname(brainDir),
          conversationId,
          mtimeMs: info.mtimeMs,
          size: info.size
        }
      }
    } catch {
      // Fall through to sibling or omit conversations that have not written logs yet.
    }
  }
  return null
}

export async function listAntigravityTranscriptFiles(
  brainDirs: readonly string[] = resolveAntigravityUsageBrainDirs({})
): Promise<AntigravityTranscriptRef[]> {
  const discovered: AntigravityTranscriptRef[] = []
  const seenRealPaths = new Set<string>()
  let visited = 0

  for (const [rootIndex, brainDir] of brainDirs.entries()) {
    const entries = await readdir(brainDir, { withFileTypes: true }).catch((error: unknown) => {
      if (isDefinitiveAbsence(error)) {
        return null
      }
      // Surface unreadable primary CLI roots while ignoring absent/inaccessible secondary roots.
      if (rootIndex === 0) {
        throw error
      }
      return null
    })
    if (!entries) {
      continue
    }
    const sortedNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))

    for (const conversationId of sortedNames) {
      visited++
      if (visited % YIELD_EVERY_ENTRIES === 0) {
        await yieldToEventLoop()
      }
      const ref = await pickConversationTranscript(brainDir, conversationId)
      if (!ref) {
        continue
      }
      const resolved = await canonicalPath(ref.path)
      if (seenRealPaths.has(resolved)) {
        continue
      }
      seenRealPaths.add(resolved)
      discovered.push(ref)
    }
  }

  return discovered
}
