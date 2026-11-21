// What Import from another app asks the bot's computer: the bots other apps keep there, and its folders
// for the one an old bot exported.
import { useEffect, useState } from 'react'
import * as z from 'zod'
import { BOT_IMPORT_APPS, type BotImportSource } from '../../../src/shared/bots/bot-import'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

const candidate = z.looseObject({
  agent: z.string(),
  name: z.string(),
  path: z.string(),
  absolutePath: z.string(),
  importedAs: z.looseObject({ botId: z.string(), name: z.string() }).optional()
})

const botImportSourcesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.import.sources',
    method: 'bots.import.sources',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-import-sources',
      z
        .looseObject({
          sources: z.array(
            z.looseObject({ app: z.string(), home: z.string(), bots: z.array(candidate) })
          )
        })
        // A newer host's app this build can't name is left out.
        .transform(({ sources }) =>
          sources.filter((source): source is BotImportSource =>
            BOT_IMPORT_APPS.some((app) => app !== 'export' && app === source.app)
          )
        )
    )
  })
)

export type BotImportSourcesRead =
  | { status: 'loading' }
  | { status: 'ready'; sources: BotImportSource[] }
  | { status: 'failed' }

/** The chosen computer's other-app bots, read once per computer, as the desktop reads them per host. */
export function useBotImportSources(client: RpcClient | null): BotImportSourcesRead {
  const [answer, setAnswer] = useState<{ client: RpcClient; read: BotImportSourcesRead } | null>(
    null
  )
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    // An older host's refusal resolves, then fails to interpret: both settle as failed.
    void (async () => botImportSourcesRead.interpret(await botImportSourcesRead.request(client)))()
      .then(
        (sources): BotImportSourcesRead => ({ status: 'ready', sources }),
        (): BotImportSourcesRead => ({ status: 'failed' })
      )
      .then((read) => live && setAnswer({ client, read }))
    return () => {
      live = false
    }
  }, [client])
  return answer && answer.client === client ? answer.read : { status: 'loading' }
}

const hostDirectoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.browse-server-dir',
    method: 'files.browseServerDir',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'host-directory',
      z.looseObject({
        resolvedPath: z.string(),
        entries: z.array(z.looseObject({ name: z.string(), isDirectory: z.boolean() })),
        pathFlavor: z.enum(['posix', 'win32'])
      })
    )
  })
)

export type HostDirectory = ReturnType<typeof hostDirectoryRead.interpret>

/** A folder on the bot's computer: `~` is its home there. */
export async function readHostDirectory(client: RpcClient, path: string): Promise<HostDirectory> {
  return hostDirectoryRead.interpret(await hostDirectoryRead.request(client, { path }))
}
