// ACP has no standard channel for standing instructions; each agent takes them its own way.

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { nativeChatScratchFolderName } from '../../native-chat/conversation-files/native-chat-scratch-folder'
import { withOpenCodeInstructionsFile } from '../../opencode/opencode-inline-config'
import type { AcpLaunchSpec } from './acp-launch-contract'
import type { InitializeResponse } from '../generated/acp-protocol.generated'
import { acpAgentName } from '../session/acp-structured-agent-definitions'
import { placeCursorOpeningRule } from '../../cursor/cursor-opening-rule'
import { writeHermesContextFile } from '../../hermes/hermes-context-file'
import {
  openCodeSourceConfigDirectory,
  openCodeTakesConfigDirInstructions,
  writeOpenCodeInstructionsConfigDir
} from '../../opencode/opencode-instructions-config-dir'

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
  /** Runs around `session/new` (never a reopen) in the session's folder; returns what undoes it. */
  aroundNewSession?: (cwd: string) => Promise<() => Promise<void>>
}

export type AcpInstructionsDelivery = (input: {
  text: string
  /** Writes the text to a file only this host's user can read, and returns its path. */
  file: () => Promise<string>
  /** Writes `content` at `path` inside a folder of this chat's own that only this host's user can
   *  read, and returns the folder. */
  folder: (path: string, content: string) => Promise<string>
  /** Makes a new, empty folder only this host's user can read, for this launch, and returns its path. */
  emptyFolder: () => Promise<string>
  /** What the child will see, inherited values included. */
  env: Readonly<Record<string, string>>
  /** The folder the agent runs in, on this host. */
  cwd: string
  /** The launched program's version; null when its check could not tell. */
  version: string | null
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

/** 1.x: appended to the user's own inline instructions, never replacing them. 2.x ignores those, so
 *  they follow the user's own global AGENTS.md in a config folder that links the rest of theirs. */
export const deliverOpenCodeInstructions: AcpInstructionsDelivery = async ({
  text,
  file,
  emptyFolder,
  env,
  version
}): Promise<AcpInstructionsLaunch | null> => {
  if (openCodeTakesConfigDirInstructions(version)) {
    const configDir = await emptyFolder()
    await writeOpenCodeInstructionsConfigDir(configDir, openCodeSourceConfigDirectory(env), text)
    return { env: { OPENCODE_CONFIG_DIR: configDir } }
  }
  const content = withOpenCodeInstructionsFile(env.OPENCODE_CONFIG_CONTENT, await file())
  return content === null ? null : { env: { OPENCODE_CONFIG_CONTENT: content } }
}

// A path keeps the text out of the process list and clear of argument-length limits.
export const deliverOmpInstructions: AcpInstructionsDelivery = async ({ file }) => ({
  args: [`--append-system-prompt=${await file()}`]
})

// Cursor reads its folder's rules once, when a session opens, and keeps them across reopens.
export const deliverCursorInstructions: AcpInstructionsDelivery = async ({ text }) => ({
  aroundNewSession: (cwd) => placeCursorOpeningRule(cwd, text)
})

// Hermes builds its system prompt from the folder's `.hermes.md` at the first turn and again at
// each compaction, so the file stays; every launch rewrites it with the current text.
export const deliverHermesInstructions: AcpInstructionsDelivery = async ({ text, cwd }) => {
  await writeHermesContextFile(cwd, text)
  return {}
}

// Copilot rebuilds them at every start from its instruction sources, so each launch passes the folder.
// Only an instructions file applies at once: an AGENTS.md there counts as nested and loads on demand.
export const deliverCopilotInstructions: AcpInstructionsDelivery = async ({
  text,
  folder,
  env
}) => {
  const dir = await folder(
    join('.github', 'instructions', 'orca.instructions.md'),
    `---\napplyTo: "**"\n---\n${text}\n`
  )
  // The list is comma-separated, so a folder with a comma in its path would silently go unread.
  if (dir.includes(',')) {
    return null
  }
  const inherited = env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS?.trim()
  return { env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: inherited ? `${inherited},${dir}` : dir } }
}

const cleared = new Map<string, Promise<void>>()

/** Stdio children never outlive the host, and one host holds a profile, so the folder is cleared
 *  on its first use in a run. */
async function instructionsRoot(dataDirectory: string): Promise<string> {
  const root = join(dataDirectory, 'acp-instructions')
  let clearing = cleared.get(root)
  if (!clearing) {
    clearing = rm(root, { recursive: true, force: true }).catch(() => undefined)
    cleared.set(root, clearing)
  }
  await clearing
  await mkdir(root, { recursive: true, mode: 0o700 })
  return root
}

// Replaced whole, so a running child of the same chat never reads a half-written file.
async function replaceFile(path: string, content: string): Promise<void> {
  const staged = `${path}.${randomUUID()}`
  await writeFile(staged, content, { mode: 0o600 })
  await rename(staged, path)
}

/** One file per chat, rewritten at each launch. */
export async function writeAcpInstructionsFile(
  dataDirectory: string,
  sessionId: string,
  text: string
): Promise<string> {
  const path = join(
    await instructionsRoot(dataDirectory),
    `${nativeChatScratchFolderName(sessionId)}.md`
  )
  await replaceFile(path, text)
  return path
}

/** One folder per chat, its file rewritten at each launch; returns the folder. */
export async function writeAcpInstructionsFolder(
  dataDirectory: string,
  sessionId: string,
  path: string,
  content: string
): Promise<string> {
  const dir = join(await instructionsRoot(dataDirectory), nativeChatScratchFolderName(sessionId))
  const target = join(dir, path)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await replaceFile(target, content)
  return dir
}

/** Removes a tree, unlinking links and junctions rather than descending into them (#1083). */
async function removeTreeKeepingLinkTargets(path: string): Promise<void> {
  const stats = await lstat(path).catch(() => null)
  if (!stats) {
    return
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    await unlink(path).catch(() => undefined)
    return
  }
  for (const name of await readdir(path).catch(() => [])) {
    await removeTreeKeepingLinkTargets(join(path, name))
  }
  await rmdir(path).catch(() => undefined)
}

const clearedFolders = new Map<string, Promise<void>>()

/** A new folder per launch, so a child still running from an earlier one keeps reading its own.
 *  Folders may link into the user's files, so clearing never follows a link (#1083). */
export async function makeAcpInstructionsFolder(
  dataDirectory: string,
  sessionId: string
): Promise<string> {
  const root = join(dataDirectory, 'acp-instructions-folders')
  let clearing = clearedFolders.get(root)
  if (!clearing) {
    clearing = removeTreeKeepingLinkTargets(root)
    clearedFolders.set(root, clearing)
  }
  await clearing
  const path = join(root, `${nativeChatScratchFolderName(sessionId)}-${randomUUID()}`)
  await mkdir(path, { recursive: true, mode: 0o700 })
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
    version?: string | null
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
    file: () => writeAcpInstructionsFile(dataDirectory, input.sessionId, text),
    folder: (path, content) =>
      writeAcpInstructionsFolder(dataDirectory, input.sessionId, path, content),
    emptyFolder: () => makeAcpInstructionsFolder(dataDirectory, input.sessionId),
    version: input.version ?? null
  })
  if (!delivered) {
    throw new Error(
      `${acpAgentName(spec.agent)} cannot take this chat's standing instructions, so it did not start`
    )
  }
  return delivered
}
