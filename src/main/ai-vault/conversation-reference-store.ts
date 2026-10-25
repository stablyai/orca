import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  ConversationSourceSchema,
  conversationReferenceUri,
  type ConversationReference,
  type ConversationReferenceCreate
} from '../../shared/conversation-reference'

const StoredConversationReference = z
  .object({
    source: ConversationSourceSchema,
    title: z.string().min(1).max(1024),
    agent: z.string().min(1).max(128)
  })
  .strict()

export type StoredConversationReference = z.infer<typeof StoredConversationReference>

function referenceDirectory(): string {
  return join(getAppEnvironment().getPath('userData'), 'conversation-references')
}

export async function saveConversationReference(
  source: ConversationReferenceCreate,
  agent: string
): Promise<ConversationReference> {
  const id = randomUUID()
  const directory = referenceDirectory()
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, `${id}.json`),
    JSON.stringify({
      source: source.source,
      title: source.title,
      agent
    }),
    { flag: 'wx', mode: 0o600 }
  )
  return { uri: conversationReferenceUri(id, source.executionHostId), title: source.title, agent }
}

export async function loadConversationReference(
  id: string
): Promise<StoredConversationReference | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return null
  }
  try {
    return StoredConversationReference.parse(
      JSON.parse(await readFile(join(referenceDirectory(), `${id}.json`), 'utf8'))
    )
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw new Error('The saved conversation reference could not be read.')
  }
}
