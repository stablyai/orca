import { readFile, rm } from 'node:fs/promises'
import { z } from 'zod'
import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import { stageCredentialFile } from '../credentials/credential-file-io'
import { CredentialsFile, openEntry, warnOnce, type Stored } from './bot-tool-credential-envelope'

const OlderLayout = z.object({ credentials: z.record(z.string(), z.unknown()) })

function missingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function readCredentialText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (missingFile(error)) {
      return null
    }
    throw error
  }
}

function parseCredentialJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function parseBotToolCredentialFile(folder: string, text: string | null): Stored {
  if (text === null) {
    return {}
  }
  const json = parseCredentialJson(text)
  const parsed = CredentialsFile.safeParse(json)
  if (parsed.success) {
    return Object.fromEntries(
      Object.entries(parsed.data.credentials).map(([id, envelope]) => [
        id,
        { envelope, entry: openEntry(folder, id, envelope) }
      ])
    )
  }
  // The old layout does not authenticate the credential's destination.
  if (OlderLayout.safeParse(json).success) {
    warnOnce(text, '[bot-tool-credentials] ignored credentials saved in the older layout')
    return {}
  }
  throw new BotFailureError('toolCredentialsUnreadable')
}

export async function readBotToolCredentialFile(
  folder: string,
  path: string
): Promise<{ text: string | null; stored: Stored }> {
  const text = await readCredentialText(path)
  return { text, stored: parseBotToolCredentialFile(folder, text) }
}

export async function publishBotToolCredentialFile(
  path: string,
  expected: string | null,
  next: Stored
): Promise<boolean> {
  const unchanged = async () => (await readCredentialText(path)) === expected
  if (Object.keys(next).length === 0) {
    if (!(await unchanged())) {
      return false
    }
    await rm(path, { force: true })
    return true
  }
  const credentials = Object.fromEntries(
    Object.entries(next).map(([id, slot]) => [id, slot.envelope])
  )
  let published = false
  await stageCredentialFile(path, `${JSON.stringify({ version: 2, credentials }, null, 2)}\n`, {
    durable: true,
    createDirectory: true,
    shouldPublish: async () => (published = await unchanged())
  })
  return published
}
