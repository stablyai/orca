import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import { botSlackApps, type Bot } from '../../shared/bot-types'
import { directSlackRequester } from '../../shared/connector-asker-contract'
import { addBotMemoryFact, dropBotMemoryFact } from '../../shared/bot-memory-lines'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'

export type SlackRequesterMemoryScope = { botId: string; teamId: string; userId: string }

export function slackRequesterMemoryScope(
  bot: Pick<Bot, 'id' | 'slack' | 'slackApps'>,
  source: string,
  asker: ConnectorAsker | undefined
): SlackRequesterMemoryScope | null {
  const requester = directSlackRequester(asker)
  if (
    source !== 'slack' ||
    !requester ||
    !botSlackApps(bot).some((app) => app.teamId === requester.teamId)
  ) {
    return null
  }
  return { botId: bot.id, ...requester }
}

const topicSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const topicFile = /^topic-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/

function memoryFile(folder: string, topic: string | undefined): string {
  if (topic === undefined) {
    return join(folder, 'MEMORY.md')
  }
  if (topic.length > 64 || !topicSlug.test(topic)) {
    throw new Error('Invalid memory topic')
  }
  return join(folder, 'memory', `topic-${topic}.md`)
}

async function absentOnMissing<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return null
    }
    throw error
  }
}

const readMemory = (path: string) => absentOnMissing(readFile(path, 'utf8'))
const writes = new Map<string, Promise<void>>()

/** Serialize each file's read/modify/write and publish only complete files. */
export function createSlackRequesterMemory(
  root: string,
  writePrivateFile: (path: string, content: string) => Promise<void>
) {
  const folder = ({ botId, teamId, userId }: SlackRequesterMemoryScope) =>
    resolve(
      root,
      createHash('sha256')
        .update(JSON.stringify([botId, teamId, userId]))
        .digest('hex')
    )
  const write = async (
    dir: string,
    topic: string | undefined,
    edit: (text: string) => string
  ): Promise<boolean> => {
    const path = memoryFile(dir, topic)
    return runKeyedSerializedOperation(writes, path, async () => {
      const previous = (await readMemory(path)) ?? ''
      const next = edit(previous)
      if (next === previous) {
        return false
      }
      await writePrivateFile(path, next)
      return true
    })
  }
  const read = async (dir: string) => {
    const [index, files] = await Promise.all([
      readMemory(memoryFile(dir, undefined)),
      absentOnMissing(readdir(join(dir, 'memory'), { withFileTypes: true }))
    ])
    const topics = (files ?? [])
      .flatMap((entry) => (entry.isFile() ? (topicFile.exec(entry.name)?.[1] ?? []) : []))
      .sort()
    return { index, topics }
  }
  return {
    bind(scope: SlackRequesterMemoryScope | null) {
      const dir = scope ? folder(scope) : null
      return {
        read: async () => (dir === null ? { index: null, topics: [] } : read(dir)),
        readTopic: async (topic: string) =>
          dir === null ? null : readMemory(memoryFile(dir, topic)),
        remember: async (text: string, date: string, topic?: string) =>
          dir !== null && write(dir, topic, (body) => addBotMemoryFact(body, text, date)),
        forget: async (fact: string, topic?: string) =>
          dir !== null && write(dir, topic, (body) => dropBotMemoryFact(body, fact).text)
      }
    }
  }
}
