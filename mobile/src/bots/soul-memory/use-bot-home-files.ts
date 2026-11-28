// Files in a bot's home folder (SOUL.md, MEMORY.md, memory/), read on the bot's host as the desktop's
// Settings reads them, and again with the route's reads; a failed re-read keeps what was showing.
import { useCallback, useEffect, useRef, useState } from 'react'
import { BOT_MEMORY_ARCHIVE } from '../../../../src/shared/bots/bot-memory-archive'
import { isConfirmedFileNotFoundError } from '../../../../src/shared/file-write/file-write-disk-precondition'
import { folderWorkspaceKey } from '../../../../src/shared/workspace/identity/workspace-scope'
import { fileDirectoryRead } from '../../files/explorer/mobile-file-explorer-operations'
import { fileTabTextRead } from '../../files/session-documents/mobile-file-tab-doc-operations'
import { isHostNotConnectedError } from '../../query/host-query-errors'
import { hostReadClient } from '../../query/host-read-client'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

export type BotHomeFileRead =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  /** Can't be read while the host is away; the page's banner says so. */
  | { status: 'offline' }
  | { status: 'failed'; error: string }

function homeWorktree(folderWorkspaceId: string): string {
  return `id:${folderWorkspaceKey(folderWorkspaceId)}`
}

async function readText(
  client: RpcClient,
  folderWorkspaceId: string,
  relativePath: string
): Promise<string> {
  try {
    const reply = await fileTabTextRead.request(hostReadClient(client), {
      worktree: homeWorktree(folderWorkspaceId),
      relativePath
    })
    return fileTabTextRead.interpret(reply).content
  } catch (error) {
    // A file the bot deleted reads as empty, as on the desktop.
    if (isConfirmedFileNotFoundError(error)) {
      return ''
    }
    throw error
  }
}

/** One file in the bot's home; `refresh` reads it again, e.g. after a change made here. */
export function useBotHomeFile(
  client: RpcClient | null,
  folderWorkspaceId: string,
  relativePath: string,
  routeReads: number
): { read: BotHomeFileRead; refresh: () => void } {
  const key = `${folderWorkspaceId}\n${relativePath}`
  const [read, setRead] = useState<{ key: string; value: BotHomeFileRead }>({
    key,
    value: { status: 'loading' }
  })
  const [again, setAgain] = useState(0)
  // Only the newest read sets the text.
  const sent = useRef(0)
  useEffect(() => {
    if (!client) {
      return
    }
    const mine = ++sent.current
    void readText(client, folderWorkspaceId, relativePath).then(
      (text) => mine === sent.current && setRead({ key, value: { status: 'ready', text } }),
      (error: unknown) => {
        if (mine !== sent.current) {
          return
        }
        setRead((current) =>
          current.key === key && current.value.status === 'ready'
            ? current
            : {
                key,
                value: isHostNotConnectedError(error)
                  ? { status: 'offline' }
                  : { status: 'failed', error: error instanceof Error ? error.message : '' }
              }
        )
      }
    )
  }, [client, folderWorkspaceId, relativePath, key, routeReads, again])
  const refresh = useCallback(() => setAgain((value) => value + 1), [])
  return { read: read.key === key ? read.value : { status: 'loading' }, refresh }
}

export type BotMemoryTopic = { name: string; lines: number | null }

export type BotMemoryTopics = {
  /** Topic files, sorted; the archive is not one. */
  topics: readonly BotMemoryTopic[]
  archive: BotMemoryTopic | null
}

function lineCount(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length
}

async function readTopicNames(client: RpcClient, folderWorkspaceId: string): Promise<string[]> {
  const reply = await fileDirectoryRead.request(hostReadClient(client), {
    worktree: homeWorktree(folderWorkspaceId),
    relativePath: 'memory'
  })
  const listed = fileDirectoryRead.interpret(reply)
  if (!listed.accepted) {
    // No memory/ folder yet: no topic files.
    if (!reply.ok && isConfirmedFileNotFoundError(new Error(reply.error.message))) {
      return []
    }
    throw new Error(reply.ok ? 'files.readDir refused' : reply.error.message)
  }
  return listed.value.entries
    .filter((entry) => !entry.isDirectory && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()
}

/** memory/'s file names, read again with the route; null until listed, and when it can't be. */
export function useBotMemoryTopicNames(
  client: RpcClient | null,
  folderWorkspaceId: string,
  routeReads: number
): readonly string[] | null {
  const [listing, setListing] = useState<{ key: string; names: string[] } | null>(null)
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    readTopicNames(client, folderWorkspaceId).then(
      (names) => live && setListing({ key: folderWorkspaceId, names }),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [client, folderWorkspaceId, routeReads])
  return listing && listing.key === folderWorkspaceId ? listing.names : null
}

/** How many topic files, the archive aside. */
export function botMemoryTopicCount(names: readonly string[]): number {
  return names.filter((name) => name !== BOT_MEMORY_ARCHIVE).length
}

/** The Memory page's topic files and archive, each with its line count once read (once per listing). */
export function useBotMemoryTopics(
  client: RpcClient | null,
  folderWorkspaceId: string,
  names: readonly string[] | null
): BotMemoryTopics | null {
  const [lines, setLines] = useState<ReadonlyMap<string, number>>(new Map())
  const key = names?.join('\n') ?? null
  useEffect(() => {
    if (!client || !key) {
      return
    }
    let live = true
    for (const name of key.split('\n')) {
      void readText(client, folderWorkspaceId, `memory/${name}`).then(
        (text) => live && setLines((current) => new Map(current).set(name, lineCount(text))),
        () => undefined
      )
    }
    return () => {
      live = false
    }
  }, [client, folderWorkspaceId, key])
  if (!names) {
    return null
  }
  const topic = (name: string): BotMemoryTopic => ({ name, lines: lines.get(name) ?? null })
  return {
    topics: names.filter((name) => name !== BOT_MEMORY_ARCHIVE).map(topic),
    archive: names.includes(BOT_MEMORY_ARCHIVE) ? topic(BOT_MEMORY_ARCHIVE) : null
  }
}
