// One short, separate agent run that makes a single avatar image, outside the user's chats.
import { mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative } from 'node:path'
import type {
  AvatarGenerationFailure,
  AvatarImageAgent,
  GeneratedAvatarImage
} from '../../shared/avatar-generation/avatar-generation-contract'
import { MAX_BOT_AVATAR_SOURCE_BYTES } from '../../shared/bot-avatar'
import {
  grokEncodedCwdDirName,
  resolveGrokSessionsDir
} from '../../shared/agent-hook-listener/providers/grok/grok-session-paths'
import { removeTree } from '../../shared/file-write/windows-transient-lock-removal'
import { spawnSourceControlAgent } from '../text-generation/execution/source-control-agent-launch'
import { killSourceControlAgentProcess } from '../text-generation/execution/source-control-agent-termination'
import {
  agentErrorText,
  antigravityConversationIds,
  agentReplyText,
  classifyAvatarAgentFailure,
  codexThreadId,
  grokImagePaths
} from './avatar-image-agent-output'

const PROMPT_FILE = 'prompt.txt'

// Image tools take 30 to 60 s; a stuck run is stopped well before the user gives up on it.
const AVATAR_RUN_TIMEOUT_MS = 4 * 60_000
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

type AgentExit =
  | { kind: 'exit'; code: number | null; stdout: string; stderr: string }
  | { kind: 'timed-out'; stdout: string }
  | { kind: 'error'; stdout: string }

export type AvatarRunOutcome =
  | { ok: true; image: GeneratedAvatarImage }
  | { ok: false; error: AvatarGenerationFailure }

const AGENT_BINARIES: Record<AvatarImageAgent, string> = {
  codex: 'codex',
  grok: 'grok',
  antigravity: 'agy'
}

// agy makes images only through its built-in image-generator subagent, which saves under its own home.
const ANTIGRAVITY_IMAGE_STEER =
  'Use the image-generator subagent for this and wait for it to finish. Do not copy, move or save the image yourself.'

function agentArgs(agent: AvatarImageAgent, cwd: string, prompt: string): string[] {
  if (agent === 'codex') {
    // Read-only: the image tool saves under CODEX_HOME by itself; the run needs no shell or writes.
    // Low effort makes the same picture about a fifth faster than a high default.
    return [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '-s',
      'read-only',
      '-c',
      'model_reasoning_effort="low"',
      '-C',
      cwd,
      '-'
    ]
  }
  if (agent === 'antigravity') {
    // Headless agy denies every tool that would ask for approval, so it can't run commands or write files.
    return [
      '-p',
      `${ANTIGRAVITY_IMAGE_STEER} ${prompt}`,
      '--output-format',
      'stream-json',
      '--print-timeout',
      '230s'
    ]
  }
  // The image tool is the only tool and the only one allowed; dontAsk refuses anything else,
  // and with Grok's default config it refuses the image tool too unless allowed by name.
  return [
    '--prompt-file',
    join(cwd, PROMPT_FILE),
    '--permission-mode',
    'dontAsk',
    '--tools',
    'image_gen',
    '--allow',
    'image_gen',
    '--disable-web-search',
    // Low effort makes the same picture about a fifth faster.
    '--reasoning-effort',
    'low',
    '--output-format',
    'streaming-json',
    '--cwd',
    cwd
  ]
}

/** agy keeps each conversation's files under brain/<id> and its record in conversations/<id>.db. */
function antigravityHome(): string {
  return join(homedir(), '.gemini', 'antigravity-cli')
}

function antigravityRunFiles(stdout: string): string[] {
  const home = antigravityHome()
  return antigravityConversationIds(stdout).flatMap((id) => [
    join(home, 'brain', id),
    ...['.db', '.db-wal', '.db-shm'].map((suffix) => join(home, 'conversations', `${id}${suffix}`))
  ])
}

function codexImagesDir(stdout: string, env: NodeJS.ProcessEnv | undefined): string | null {
  const threadId = codexThreadId(stdout)
  // The child's own env decides its home: a prepared env may drop an inherited CODEX_HOME.
  const childEnv = env ?? process.env
  const codexHome = childEnv.CODEX_HOME ?? join(childEnv.HOME ?? homedir(), '.codex')
  return threadId ? join(codexHome, 'generated_images', threadId) : null
}

/** Grok files each run's session (history and image) under its cwd, which here is the temp folder. */
async function grokRunSessionDirs(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<string[]> {
  const sessions = resolveGrokSessionsDir(env ?? process.env)
  const roots = new Set([sessions, await realpath(sessions).catch(() => sessions)])
  const names = new Set([cwd, await realpath(cwd).catch(() => cwd)])
  return [...roots].flatMap((root) =>
    [...names].flatMap((path) => {
      const name = grokEncodedCwdDirName(path)
      return name ? [join(root, name)] : []
    })
  )
}

function isInside(directory: string, path: string): boolean {
  const inside = relative(directory, path)
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
}

async function newestImageIn(directory: string): Promise<string | null> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return null
  }
  const images = names.filter((name) => IMAGE_MIME_TYPES[extname(name).toLowerCase()])
  let newest: { path: string; mtime: number } | null = null
  for (const name of images) {
    const path = join(directory, name)
    const mtimeMs = (await stat(path).catch(() => null))?.mtimeMs ?? 0
    if (!newest || mtimeMs > newest.mtime) {
      newest = { path, mtime: mtimeMs }
    }
  }
  return newest?.path ?? null
}

async function imagePath(
  agent: AvatarImageAgent,
  stdout: string,
  env: NodeJS.ProcessEnv | undefined,
  grokSessionDirs: string[]
): Promise<string | null> {
  if (agent === 'grok') {
    const path = grokImagePaths(stdout).at(-1)
    if (!path || !isAbsolute(path)) {
      return null
    }
    // Read only what this run saved in its own session folder, whatever a reply claims.
    const real = await realpath(path).catch(() => null)
    return real && grokSessionDirs.some((dir) => isInside(dir, real)) ? real : null
  }
  if (agent === 'antigravity') {
    // The main conversation holds the image; its subagents' folders are a fallback.
    for (const id of antigravityConversationIds(stdout)) {
      const path = await newestImageIn(join(antigravityHome(), 'brain', id))
      if (path) {
        return path
      }
    }
    return null
  }
  const directory = codexImagesDir(stdout, env)
  return directory ? newestImageIn(directory) : null
}

async function readImage(path: string): Promise<GeneratedAvatarImage | null> {
  const mimeType = IMAGE_MIME_TYPES[extname(path).toLowerCase()]
  if (!mimeType) {
    return null
  }
  const { size } = await stat(path)
  if (size === 0 || size > MAX_BOT_AVATAR_SOURCE_BYTES) {
    return null
  }
  return { mimeType, base64: (await readFile(path)).toString('base64') }
}

/** Runs the agent once in an empty temp folder; `signal` stops it and its process tree. */
export async function runAvatarImageAgent(input: {
  agent: AvatarImageAgent
  prompt: string
  env: NodeJS.ProcessEnv | undefined
  signal: AbortSignal
}): Promise<AvatarRunOutcome> {
  const { agent, prompt, env, signal } = input
  if (signal.aborted) {
    return { ok: false, error: 'canceled' }
  }
  const cwd = await mkdtemp(join(tmpdir(), 'orca-avatar-'))
  let cleanup: string[] = []
  try {
    if (agent === 'grok') {
      // A file keeps the prompt out of argv: no Windows shim quoting, nothing in `ps`.
      await writeFile(join(cwd, PROMPT_FILE), prompt, 'utf-8')
    }
    // An abort while the folder was made has no listener to hear it.
    if (signal.aborted) {
      return { ok: false, error: 'canceled' }
    }
    const exit = await new Promise<AgentExit>((resolve) => {
      let child: ReturnType<typeof spawnSourceControlAgent>
      try {
        child = spawnSourceControlAgent({
          binary: AGENT_BINARIES[agent],
          args: agentArgs(agent, cwd, prompt),
          cwd,
          env,
          stdinMode: agent === 'codex' ? 'pipe' : 'ignore',
          useCwdForNative: true
        })
      } catch (error) {
        console.error('[avatar-generation] Failed to start the image agent:', error)
        resolve({ kind: 'error', stdout: '' })
        return
      }
      let stdout = ''
      let stderr = ''
      let done = false
      const stop = (): Promise<void> =>
        killSourceControlAgentProcess(child).catch((error: unknown) => {
          console.error('[avatar-generation] Failed to stop the image agent:', error)
        })
      // Cleanup follows the stop, so a dying agent can't write into a folder being removed.
      const timer = setTimeout(() => {
        void stop().then(() => finish({ kind: 'timed-out', stdout }))
      }, AVATAR_RUN_TIMEOUT_MS)
      const onAbort = (): void => void stop()
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        void stop()
      }
      function finish(value: AgentExit): void {
        if (done) {
          return
        }
        done = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      // Decoded per stream, so a character split across chunks stays whole (paths can be non-ASCII).
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length < MAX_OUTPUT_CHARS) {
          stdout += chunk
        }
      })
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < MAX_OUTPUT_CHARS) {
          stderr += chunk
        }
      })
      child.on('error', (error: Error) => {
        if (!('code' in error) || error.code !== 'ENOENT') {
          console.error('[avatar-generation] Image agent failed:', error)
        }
        finish({ kind: 'error', stdout })
      })
      child.on('close', (code: number | null) => finish({ kind: 'exit', code, stdout, stderr }))
      if (agent === 'codex') {
        child.stdin?.on?.('error', () => {})
        child.stdin?.end(prompt)
      }
    })
    // The run is one-off, even when canceled or timed out: its images and Grok session
    // must not pile up or show in session history.
    const grokSessionDirs = agent === 'grok' ? await grokRunSessionDirs(cwd, env) : []
    const codexDir = agent === 'codex' ? codexImagesDir(exit.stdout, env) : null
    cleanup =
      agent === 'antigravity'
        ? antigravityRunFiles(exit.stdout)
        : codexDir
          ? [codexDir]
          : grokSessionDirs
    if (signal.aborted) {
      return { ok: false, error: 'canceled' }
    }
    if (exit.kind === 'error') {
      return { ok: false, error: 'failed' }
    }
    if (exit.kind === 'timed-out') {
      return { ok: false, error: 'timed-out' }
    }
    const path = await imagePath(agent, exit.stdout, env, grokSessionDirs).catch(() => null)
    const image = path ? await readImage(path).catch(() => null) : null
    if (image) {
      return { ok: true, image }
    }
    const errorText = `${agentErrorText(exit.stdout)}\n${exit.stderr}`
    if (exit.code !== 0) {
      return { ok: false, error: classifyAvatarAgentFailure(errorText) }
    }
    if (/\bREFUSED\b/.test(agentReplyText(exit.stdout))) {
      return { ok: false, error: 'no-image' }
    }
    const failure = classifyAvatarAgentFailure(errorText)
    return { ok: false, error: failure === 'failed' ? 'no-image' : failure }
  } finally {
    for (const directory of [cwd, ...cleanup]) {
      void removeTree(directory).catch(() => {})
    }
  }
}
