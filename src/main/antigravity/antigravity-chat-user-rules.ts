// Discovers and formats user rule files (GEMINI.md, AGENTS.md) and session safety metadata for Antigravity ACP sessions.

import { open, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { antigravityUserHome } from './antigravity-chat-user-skills'

export type AntigravityUserRulesInput = {
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
}

export type AntigravitySessionMeta = {
  antigravity: {
    disabledTools?: readonly string[]
    systemPrompt?: {
      append: string
    }
  }
}

/** Maximum bytes read per rule file to avoid line overflow or excessive memory usage. */
export const MAX_RULE_FILE_BYTES = 256 * 1024

const GLOBAL_RULE_FILENAMES = ['GEMINI.md', 'AGENTS.md'] as const
const WORKSPACE_RULE_FILENAMES = ['AGENTS.md', 'GEMINI.md'] as const

const USER_RULES_HEADER =
  '<user_rules>\n' +
  'The following are user-defined rules that you MUST ALWAYS FOLLOW WITHOUT ANY EXCEPTION. These rules take precedence over any other instructions.\n' +
  'Review them carefully and always take them into account when you generate responses and code:'

/** Read up to `MAX_RULE_FILE_BYTES` from a rule file and resolve its canonical path for deduplication. */
async function readRuleEntry(
  filePath: string,
  platform: NodeJS.Platform
): Promise<{ path: string; canonicalKey: string; content: string } | null> {
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      return null
    }
    const file = await open(filePath, 'r')
    let content = ''
    try {
      const buffer = Buffer.alloc(Math.min(fileStat.size, MAX_RULE_FILE_BYTES))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      content = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
    const trimmed = content.trim()
    if (!trimmed) {
      return null
    }
    const resolved = await realpath(filePath).catch(() => filePath)
    const canonicalKey = platform === 'win32' ? resolved.toLowerCase() : resolved
    return { path: filePath, canonicalKey, content: trimmed }
  } catch {
    return null
  }
}

/** Resolve the user's home directory across POSIX and Windows launch environments. */
function resolveRulesHome(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): string {
  if (platform === 'win32' && !env.USERPROFILE && !(env.HOMEDRIVE && env.HOMEPATH) && env.HOME) {
    return env.HOME
  }
  return antigravityUserHome(env, platform)
}

/** Load and format global and workspace rule files into the standard `<user_rules>` XML block. */
export async function loadAntigravityUserRules(
  input: AntigravityUserRulesInput
): Promise<string | undefined> {
  try {
    const platform = input.platform ?? process.platform
    const home = resolveRulesHome(input.env, platform)
    const seenCanonical = new Set<string>()
    const ruleBlocks: string[] = []

    for (const filename of GLOBAL_RULE_FILENAMES) {
      const candidate = join(home, '.gemini', filename)
      const entry = await readRuleEntry(candidate, platform)
      if (!entry || seenCanonical.has(entry.canonicalKey)) {
        continue
      }
      seenCanonical.add(entry.canonicalKey)
      ruleBlocks.push(`<RULE[user_global]>\n${entry.content}\n</RULE[user_global]>`)
    }

    for (const filename of WORKSPACE_RULE_FILENAMES) {
      const candidate = join(input.cwd, filename)
      const entry = await readRuleEntry(candidate, platform)
      if (!entry || seenCanonical.has(entry.canonicalKey)) {
        continue
      }
      seenCanonical.add(entry.canonicalKey)
      ruleBlocks.push(`<RULE[${entry.path}]>\n${entry.content}\n</RULE[${entry.path}]>`)
    }

    if (ruleBlocks.length === 0) {
      return undefined
    }

    return `${USER_RULES_HEADER}\n${ruleBlocks.join('\n')}\n</user_rules>`
  } catch {
    return undefined
  }
}

/** Resolve session start metadata containing client system prompt instructions for user rules. */
export async function resolveAntigravityUserRulesMeta(
  input: AntigravityUserRulesInput
): Promise<AntigravitySessionMeta | undefined> {
  return await resolveAntigravitySessionMeta(input)
}

/** Compose Antigravity ACP `_meta` combining optional workflow tool suppression and user rules. */
export async function resolveAntigravitySessionMeta(
  input: AntigravityUserRulesInput & { disableRunWorkflow?: boolean }
): Promise<AntigravitySessionMeta | undefined> {
  const append = await loadAntigravityUserRules(input)
  if (!append && !input.disableRunWorkflow) {
    return undefined
  }
  return {
    antigravity: {
      ...(input.disableRunWorkflow ? { disabledTools: ['run_workflow'] } : {}),
      ...(append ? { systemPrompt: { append } } : {})
    }
  }
}
