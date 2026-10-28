import { expect, vi } from 'vitest'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { randomUUID } from 'node:crypto'
import { envelope } from './wsl-orcad-chat-envelope'
import type { ChatInstall, ChatLane } from './wsl-orcad-structured-chat-contract'

/** Guest file every Windows-side agent decoy appends to each time anything runs it. */
export const WSL_CHAT_DECOY_MARKER = 'orca-lane-claude-decoy-ran'

/** Windows dir (under the lane's work dir) the lane puts on its own PATH, which WSL appends to orcad's. */
export const WSL_CHAT_WINDOWS_DECOY_DIR = 'windows-claude-install'

/** Windows-side installs of each agent the lane chats with; a guest install must shadow every one. */
export const WSL_CHAT_WINDOWS_DECOY_AGENTS = ['claude', 'codex', 'grok'] as const

/** A Windows install as WSL interop exposes it: an npm-style sh shim on the Windows PATH. */
export const WSL_CHAT_WINDOWS_DECOY = [
  '#!/bin/sh',
  `printf '%s\\n' "$0 $*" >> "$HOME/${WSL_CHAT_DECOY_MARKER}"`,
  `[ "$1" = --version ] && { echo '2.1.258 (Claude Code)'; exit 0; }`,
  'exit 1',
  ''
].join('\n')

async function decoyRuns(lane: ChatLane, home: string): Promise<string[]> {
  const marker = quotePosixShell(`${home}/${WSL_CHAT_DECOY_MARKER}`)
  return (await lane.guest(`cat ${marker} 2>/dev/null || true`)).split('\n').filter(Boolean)
}

/** orcad's own PATH entries, as its children inherit them. */
async function orcadPathEntries(lane: ChatLane): Promise<string[]> {
  const path = await lane.guest(
    `tr '\\0' '\\n' < /proc/${lane.runtimePid}/environ | sed -n 's/^PATH=//p'`
  )
  return path.trim().split(':').filter(Boolean)
}

/** Without this, "never ran" could pass because WSL never exposed the decoy at all. */
export async function expectWindowsDecoyReachable(lane: ChatLane): Promise<string> {
  const dir = (await orcadPathEntries(lane)).find((entry) =>
    entry.replace(/\/+$/u, '').endsWith(`/${WSL_CHAT_WINDOWS_DECOY_DIR}`)
  )
  expect(dir, "the decoy's Windows dir on orcad's PATH").toBeDefined()
  const decoy = `${dir}/claude`
  // A scratch HOME keeps this run out of the marker the "never ran" checks read.
  const ran = await lane.guest(
    `scratch=$(mktemp -d) && HOME="$scratch" ${quotePosixShell(decoy)} --version && cat "$scratch/${WSL_CHAT_DECOY_MARKER}" && rm -rf "$scratch"`
  )
  expect(ran).toContain('(Claude Code)')
  expect(ran).toContain(`${decoy} --version`)
  return decoy
}

/** A guest install ahead of WSL's appended Windows PATH must keep the Windows one unrun. */
export async function expectWindowsDecoyUnrun(lane: ChatLane, home: string): Promise<void> {
  expect(await decoyRuns(lane, home)).toEqual([])
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** With no guest install left, whether orcad runs the Windows-side `claude`; records, the caller asserts. */
export async function probeWindowsDecoy(lane: ChatLane, install: ChatInstall, worktree: string) {
  const errors: string[] = []
  const attempt = async <T>(step: () => Promise<T>): Promise<T | null> => {
    try {
      return await step()
    } catch (error) {
      errors.push(errorText(error))
      return null
    }
  }
  await attempt(() => lane.guest(`rm -f ${quotePosixShell(install.cli)}`))
  let support: unknown = null
  let runs: string[] = []
  // The shell env refreshes on a miss or after its TTL; poll past both.
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    support = await attempt(() =>
      lane.rpc('agentSession.createSupport', { worktree, agent: 'claude' })
    )
    runs = (await attempt(() => decoyRuns(lane, install.home))) ?? []
    if (runs.length > 0) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  return { support, decoyRuns: runs, errors }
}

/**
 * A chat with only a Windows `claude` must refuse, never start that copy: `cliMissing` when the
 * chat's login PATH shows the Windows copy, else a plain ENOENT (Debian's /etc/profile resets PATH).
 */
const WINDOWS_ONLY_REFUSAL = /cliMissing|spawn claude ENOENT/u

export async function expectWindowsOnlyChatRefused(lane: ChatLane, worktree: string) {
  const sessionId = randomUUID()
  const fields = { worktree, agent: 'claude' }
  const outcome = (step: Promise<unknown>) =>
    step.then(
      (value) => value,
      (error: unknown) => ({ thrown: errorText(error) })
    )
  const created = await outcome(
    lane.rpc('agentSession.create', {
      ...fields,
      envelope: envelope(sessionId, 'agentSession.create', fields, null)
    })
  )
  const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
  const sent = await outcome(
    lane.rpc('agentSession.send', {
      body,
      envelope: envelope(sessionId, 'agentSession.send', { body }, null)
    })
  )
  let history: unknown = null
  await vi
    .waitFor(
      async () => {
        history = await outcome(
          lane.rpc('agentSession.history', { sessionId, direction: 'tail', limit: 50 })
        )
        expect(JSON.stringify([created, sent, history])).toMatch(WINDOWS_ONLY_REFUSAL)
      },
      { timeout: 60_000, interval: 2_000 }
    )
    .catch(() => {})
  await outcome(lane.rpc('agentSession.close', { sessionId }))
  const seen = { created, sent, history }
  expect(JSON.stringify(seen), JSON.stringify(seen)).toMatch(WINDOWS_ONLY_REFUSAL)
  return seen
}
