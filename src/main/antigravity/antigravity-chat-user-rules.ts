// Discovers and formats user rule files (GEMINI.md, AGENTS.md) for Antigravity ACP sessions.

import { open, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { antigravityUserHome } from './antigravity-chat-user-skills'

export type AntigravityUserRulesInput = {
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
}

export type AntigravityUserRulesMeta = {
  antigravity: {
    systemPrompt: {
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

async function readRuleEntry(
  filePath: string
): Promise<{ path: string; canonicalPath: string; content: string } | null> {
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
    const canonicalPath = await realpath(filePath).catch(() => filePath)
    return { path: filePath, canonicalPath, content: trimmed }
  } catch {
    return null
  }
}

/** Loads and formats user rule files into the standard <user_rules> XML block. */
export async function loadAntigravityUserRules(
  input: AntigravityUserRulesInput
): Promise<string | undefined> {
  try {
    const home = antigravityUserHome(input.env, input.platform)
    const seenCanonical = new Set<string>()
    const ruleBlocks: string[] = []

    for (const filename of GLOBAL_RULE_FILENAMES) {
      const candidate = join(home, '.gemini', filename)
      const entry = await readRuleEntry(candidate)
      if (!entry || seenCanonical.has(entry.canonicalPath)) {
        continue
      }
      seenCanonical.add(entry.canonicalPath)
      ruleBlocks.push(`<RULE[user_global]>\n${entry.content}\n</RULE[user_global]>`)
      break
    }

    for (const filename of WORKSPACE_RULE_FILENAMES) {
      const candidate = join(input.cwd, filename)
      const entry = await readRuleEntry(candidate)
      if (!entry || seenCanonical.has(entry.canonicalPath)) {
        continue
      }
      seenCanonical.add(entry.canonicalPath)
      ruleBlocks.push(`<RULE[${entry.path}]>\n${entry.content}\n</RULE[${entry.path}]>`)
      break
    }

    if (ruleBlocks.length === 0) {
      return undefined
    }

    return `${USER_RULES_HEADER}\n${ruleBlocks.join('\n')}\n</user_rules>`
  } catch {
    return undefined
  }
}

/** Resolves session start metadata with client system prompt instructions for user rules. */
export async function resolveAntigravityUserRulesMeta(
  input: AntigravityUserRulesInput
): Promise<AntigravityUserRulesMeta | undefined> {
  const append = await loadAntigravityUserRules(input)
  if (!append) {
    return undefined
  }
  return {
    antigravity: {
      systemPrompt: {
        append
      }
    }
  }
}
