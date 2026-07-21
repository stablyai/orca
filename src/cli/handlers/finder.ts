import { isAbsolute } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

type FinderTerminalResult = {
  terminal: {
    handle?: string
    path?: string
    title?: string | null
  }
}

type FinderWorkspaceResult = {
  workspace: {
    id?: string
    path?: string
    name?: string | null
  }
  terminal?: {
    handle?: string
  } | null
}

function requireAbsoluteFinderPath(flags: Map<string, string | boolean>, command: string): string {
  const folderPath = getOptionalStringFlag(flags, 'path')
  if (folderPath === undefined || !isAbsolute(folderPath)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Finder ${command} requires --path to be an absolute folder path.`
    )
  }
  return folderPath
}

function formatFinderTerminal(value: FinderTerminalResult): string {
  const terminal = value.terminal
  const title = terminal.title ? ` (${terminal.title})` : ''
  return `Opened Finder folder in terminal${title}: ${terminal.path ?? terminal.handle ?? 'ready'}`
}

function formatFinderWorkspace(value: FinderWorkspaceResult): string {
  const workspace = value.workspace
  const name = workspace.name ? ` (${workspace.name})` : ''
  const terminal = value.terminal?.handle ? ` with terminal ${value.terminal.handle}` : ''
  return `Opened Finder folder workspace${name}: ${workspace.path ?? workspace.id ?? 'ready'}${terminal}`
}

export const FINDER_HANDLERS: Record<string, CommandHandler> = {
  'finder terminal': async ({ flags, client, json }) => {
    const folderPath = requireAbsoluteFinderPath(flags, 'terminal')
    if (client.isRemote) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Finder terminal requires a local Orca runtime.'
      )
    }
    await client.openOrca()
    const result = await client.call<FinderTerminalResult>('finder.openTerminalAtPath', {
      path: folderPath,
      title: getOptionalStringFlag(flags, 'title')
    })
    printResult(result, json, formatFinderTerminal)
  },
  'finder workspace': async ({ flags, client, json }) => {
    const folderPath = requireAbsoluteFinderPath(flags, 'workspace')
    if (client.isRemote) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Finder workspace requires a local Orca runtime.'
      )
    }
    await client.openOrca()
    const result = await client.call<FinderWorkspaceResult>('finder.openWorkspaceAtPath', {
      path: folderPath,
      name: getOptionalStringFlag(flags, 'name'),
      terminal: flags.get('terminal') === true
    })
    printResult(result, json, formatFinderWorkspace)
  }
}
