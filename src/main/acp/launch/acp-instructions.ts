// ACP has no standard channel for standing instructions; each agent takes them its own way.

import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { nativeChatScratchFolderName } from '../../native-chat/conversation-files/native-chat-scratch-folder'
import { withOpenCodeInstructionsFile } from '../../opencode/opencode-inline-config'
import type { AcpLaunchSpec } from './acp-launch-contract'
import type { InitializeResponse } from '../generated/acp-protocol.generated'
import { acpAgentName } from '../session/acp-structured-agent-definitions'

/** What a launch adds so the agent's own system prompt carries the instructions. */
export type AcpInstructionsLaunch = {
  /** After the agent's own arguments. */
  args?: string[]
  env?: Record<string, string>
  /** `_meta` on `session/new`, and on a reopen only with `sessionMetaOnReopen`. */
  sessionMeta?: Record<string, unknown>
  /** The agent keeps none across its own restarts, so every reopen sends `sessionMeta` again. */
  sessionMetaOnReopen?: true
  /** Whether the agent's `initialize` says it takes `sessionMeta`; a session it doesn't never opens. */
  takesSessionMeta?: (initialized: InitializeResponse) => boolean
}

export type AcpInstructionsDelivery = (input: {
  text: string
  /** Writes the text to a file only this host's user can read, and returns its path. */
  file: () => Promise<string>
  /** What the child will see, inherited values included. */
  env: Readonly<Record<string, string>>
  /** The session folder the agent starts in. */
  cwd: string
}) => Promise<AcpInstructionsLaunch | null>

// Grok keeps them with the session, so a reopened conversation keeps the preamble it began with.
export const deliverGrokInstructions: AcpInstructionsDelivery = async ({ text }) => ({
  sessionMeta: { rules: text }
})

const AntigravitySystemPromptCapability = z.object({
  antigravity: z.object({ systemPrompt: z.object({ append: z.literal(true) }) })
})

/** Whether the Antigravity server appends `_meta.antigravity.systemPrompt.append` to its system prompt. */
export function antigravityTakesSystemPrompt(initialized: InitializeResponse): boolean {
  return AntigravitySystemPromptCapability.safeParse(initialized.agentCapabilities?._meta).success
}

// Orca's managed server forgets it when it restarts, and a re-sent text replaces the old one.
export const deliverAntigravityInstructions: AcpInstructionsDelivery = async ({ text }) => ({
  sessionMeta: { antigravity: { systemPrompt: { append: text } } },
  sessionMetaOnReopen: true,
  takesSessionMeta: antigravityTakesSystemPrompt
})

/** Appended to the user's own inline instructions, never replacing them. */
export const deliverOpenCodeInstructions: AcpInstructionsDelivery = async ({ file, env }) => {
  const content = withOpenCodeInstructionsFile(env.OPENCODE_CONFIG_CONTENT, await file())
  return content === null ? null : { env: { OPENCODE_CONFIG_CONTENT: content } }
}

// A path keeps the text out of the process list and clear of argument-length limits.
export const deliverOmpInstructions: AcpInstructionsDelivery = async ({ file }) => ({
  args: [`--append-system-prompt=${await file()}`]
})

/** Cursor's always-apply rule in the session folder. Cursor ACP has no system-prompt field. */
export const CURSOR_BOT_RULE = join('.cursor', 'rules', 'orca-bot.mdc')

/** The rule file Cursor reads into each completion. `alwaysApply` is what ACP sessions load. */
export function cursorBotRule(text: string): string {
  return `---\nalwaysApply: true\n---\n\n${text}`
}

// Cursor's own answer (2026-07) is that ACP cannot prepend a system prompt, and that a project rule
// carries the guidance instead. The bot home is that project. Rewritten on every launch, including
// a reopen, so a later preamble replaces the file the next completion reads.
export const deliverCursorInstructions: AcpInstructionsDelivery = async ({ text, cwd }) => {
  const path = join(cwd, CURSOR_BOT_RULE)
  await mkdir(join(cwd, '.cursor', 'rules'), { recursive: true })
  const staged = `${path}.${randomUUID()}`
  await writeFile(staged, cursorBotRule(text), { mode: 0o600 })
  await rename(staged, path)
  return {}
}

const cleared = new Map<string, Promise<void>>()

/** One file per chat, rewritten at each launch. Stdio children never outlive the host, and one host
 *  holds a profile, so the folder is cleared on its first use in a run. */
export async function writeAcpInstructionsFile(
  dataDirectory: string,
  sessionId: string,
  text: string
): Promise<string> {
  const root = join(dataDirectory, 'acp-instructions')
  let clearing = cleared.get(root)
  if (!clearing) {
    clearing = rm(root, { recursive: true, force: true }).catch(() => undefined)
    cleared.set(root, clearing)
  }
  await clearing
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, `${nativeChatScratchFolderName(sessionId)}.md`)
  // Replaced whole, so a running child of the same chat never reads a half-written file.
  const staged = `${path}.${randomUUID()}`
  await writeFile(staged, text, { mode: 0o600 })
  await rename(staged, path)
  return path
}

/** Null for a session without instructions; throws when the agent cannot take them, so the session
 *  never starts without them. */
export async function acpLaunchInstructions(
  spec: Pick<AcpLaunchSpec, 'agent' | 'instructions'>,
  dataDirectory: string,
  input: {
    sessionId: string
    text: string | null
    env: Readonly<Record<string, string>>
    cwd: string
  }
): Promise<AcpInstructionsLaunch | null> {
  const { text } = input
  if (!text) {
    return null
  }
  const delivered = await spec.instructions?.({
    text,
    env: input.env,
    cwd: input.cwd,
    file: () => writeAcpInstructionsFile(dataDirectory, input.sessionId, text)
  })
  if (!delivered) {
    throw new Error(
      `${acpAgentName(spec.agent)} cannot take this chat's standing instructions, so it did not start`
    )
  }
  return delivered
}
