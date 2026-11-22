// Where a bot's tools file lives, and the address it gives one credential, read without the editor's
// checks so the relay can compare it with the sealed one.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export const botToolsPath = (folder: string): string => join(folder, '.orca', 'bot-tools.json')

const ToolsFile = z.object({
  servers: z.array(z.unknown())
})
const NamedTool = z.object({ url: z.string(), credential: z.string() })

/** The URL of the tool in `folder`'s tools file that names `credentialId`, or null when none does. */
export async function botToolUrlOf(folder: string, credentialId: string): Promise<string | null> {
  let file: unknown
  try {
    file = JSON.parse(await readFile(botToolsPath(folder), 'utf8'))
  } catch {
    return null
  }
  const parsed = ToolsFile.safeParse(file)
  for (const server of parsed.success ? parsed.data.servers : []) {
    const tool = NamedTool.safeParse(server)
    if (tool.success && tool.data.credential === credentialId) {
      return tool.data.url
    }
  }
  return null
}
