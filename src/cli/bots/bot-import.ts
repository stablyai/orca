// `orca bot import`: bringing a bot over from another app. The bot reads the old files itself; these put
// its plan and summary in front of its owner as cards, and list the bots other apps keep on this host.
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { z } from 'zod'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { BOT_IMPORT_APP_LABELS, type BotImportSource } from '../../shared/bots/bot-import'
import {
  BotImportDoneInputSchema,
  BotImportPlanInputSchema
} from '../../shared/bots/bot-import-cards'
import { BOT_TEXT_LEFT_OUT, redactBotText } from '../../shared/bots/bot-text-scan'
import { botImportReadRefusal } from './bot-import-read-refusal'
import type { CommandHandler } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callBots } from './bot'

function requireCaller(): string {
  const callerSessionId = readInjectedAgentSessionId()
  if (!callerSessionId) {
    throw new RuntimeClientError('invalid_argument', "Run this from a bot's chat.")
  }
  return callerSessionId
}

/** The --file JSON, checked here so a mistake names the field rather than failing on the host. */
async function readCardFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const text = await readFile(resolve(path), 'utf8').catch(() => {
    throw new RuntimeClientError('invalid_argument', `Can't read ${path}.`)
  })
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new RuntimeClientError('invalid_argument', `${path} is not valid JSON.`)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new RuntimeClientError(
      'invalid_argument',
      `${path}: ${issue?.path.join('.') || 'value'}: ${issue?.message ?? 'invalid'}`
    )
  }
  return parsed.data
}

export function formatBotImportSources(sources: readonly BotImportSource[]): string {
  if (sources.length === 0) {
    return 'No OpenClaw, Hermes or OpenBot bots on this computer.'
  }
  return sources
    .map((source) =>
      [
        `${BOT_IMPORT_APP_LABELS[source.app]} (${source.home})`,
        ...source.bots.map(
          (bot) =>
            `  ${bot.name}  agent: ${bot.agent}  folder: ${bot.path}${bot.importedAs ? `  imported as ${bot.importedAs.name}` : ''}`
        )
      ].join('\n')
    )
    .join('\n')
}

const READ_MAX_BYTES = 512 * 1024

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Why a path may not be read, checking where a link leads as well as its own name. */
async function readRefusal(path: string): Promise<string | null> {
  const real = await realpath(path).catch(() => path)
  return botImportReadRefusal(path) ?? botImportReadRefusal(real)
}

/** A folder's files, one per line, each marked when it may not be read. */
async function listFolder(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true })
  const lines = await Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const shown = entry.isDirectory() ? `${entry.name}/` : entry.name
        const refusal = await readRefusal(join(path, entry.name))
        return refusal ? `${shown}  (never read: ${refusal})` : shown
      })
  )
  return lines.join('\n')
}

/** What an importing bot reads of the old app: never a key file, and never a line that looks like a secret. */
async function readForImport(path: string): Promise<string> {
  const text =
    path === '-'
      ? await readStdin()
      : await (async () => {
          const refusal = await readRefusal(resolve(path))
          if (refusal) {
            throw new RuntimeClientError('invalid_argument', `Not read: ${refusal}.`)
          }
          const info = await stat(resolve(path)).catch(() => null)
          if (!info) {
            throw new RuntimeClientError('invalid_argument', `${path} does not exist.`)
          }
          if (info.isDirectory()) {
            // Names only, so nothing to leave out; a name like credentials/ is not a secret.
            return { listing: await listFolder(resolve(path)) }
          }
          if (info.size > READ_MAX_BYTES) {
            throw new RuntimeClientError('invalid_argument', `${path} is too large to read.`)
          }
          return readFile(resolve(path), 'utf8')
        })()
  if (typeof text !== 'string') {
    return text.listing
  }
  const { text: safe, leftOut } = redactBotText(text)
  return leftOut
    ? `${safe}\n(${leftOut} line${leftOut === 1 ? '' : 's'} left out; each is marked ${BOT_TEXT_LEFT_OUT})`
    : safe
}

export const BOT_IMPORT_HANDLERS: Record<string, CommandHandler> = {
  'bot import sources': async ({ client, json }) => {
    const result = await callBots<{ sources: BotImportSource[] }>(client, 'bots.import.sources', {})
    printResult(result, json, (value) => formatBotImportSources(value.sources))
  },
  'bot import read': async ({ flags, cwd }) => {
    const path = getRequiredStringFlag(flags, 'path')
    process.stdout.write(`${await readForImport(path === '-' ? path : resolve(cwd, path))}\n`)
  },
  'bot import plan': async ({ flags, client, json }) => {
    const callerSessionId = requireCaller()
    const plan = await readCardFile(getRequiredStringFlag(flags, 'file'), BotImportPlanInputSchema)
    const result = await callBots<{ message: string }>(client, 'bots.import.plan', {
      callerSessionId,
      plan
    })
    printResult(result, json, (value) => value.message)
  },
  'bot import done': async ({ flags, client, json }) => {
    const callerSessionId = requireCaller()
    const done = await readCardFile(getRequiredStringFlag(flags, 'file'), BotImportDoneInputSchema)
    const result = await callBots<{ message: string }>(client, 'bots.import.done', {
      callerSessionId,
      done
    })
    printResult(result, json, (value) => value.message)
  }
}
