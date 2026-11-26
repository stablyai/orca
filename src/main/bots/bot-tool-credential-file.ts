import { readFile, rm } from 'node:fs/promises'
import { stageCredentialFile } from '../credentials/credential-file-io'
import { openEntry, parseEnvelopes, type Entry, type Stored } from './bot-tool-credential-envelope'

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

/** The file's entries, each opened the first time it is read: most reads and writes touch one. */
export function parseBotToolCredentialFile(folder: string, text: string | null): Stored {
  return Object.fromEntries(
    Object.entries(parseEnvelopes(text)).map(([id, envelope]) => {
      let opened: Entry | null | undefined
      const slot = {
        envelope,
        get entry() {
          return opened === undefined ? (opened = openEntry(folder, id, envelope)) : opened
        }
      }
      return [id, slot]
    })
  )
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
