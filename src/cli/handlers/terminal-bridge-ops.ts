import type { RuntimeTerminalListResult, RuntimeTerminalRename } from '../../shared/runtime-types'
import { parseTerminalIndex } from '../../shared/terminal-a2a-link'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import {
  getBrowserWorktreeSelector,
  isBrowserTarget,
  resolveBrowserTarget,
  resolveTerminalTarget,
  type ResolvedBrowserTarget
} from '../selectors'

export type TargetResolution = {
  targetDisplay: string
  handle: string
  worktree: string | undefined
  isBrowser: boolean
  browserInfo?: ResolvedBrowserTarget
}

export async function resolveTargetAndHandle(
  targetArg: string | undefined,
  ctx: HandlerContext
): Promise<TargetResolution> {
  if (!targetArg) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Target is required (e.g. @1, @2 for terminals, or @b1, @b2 for browsers).'
    )
  }
  const worktree = await getBrowserWorktreeSelector(ctx.flags, ctx.cwd, ctx.client)
  if (isBrowserTarget(targetArg)) {
    const browserInfo = await resolveBrowserTarget(targetArg, worktree, ctx.client)
    return {
      targetDisplay: `@b${browserInfo.index}`,
      handle: browserInfo.browserPageId,
      worktree,
      isBrowser: true,
      browserInfo
    }
  }
  const handle = await resolveTerminalTarget(targetArg, worktree, ctx.client)
  return { targetDisplay: targetArg, handle, worktree, isBrowser: false }
}

export async function resolveSenderIdentity(
  client: HandlerContext['client'],
  worktree: string | undefined
): Promise<{ from: string; handle: string; worktreeLabel: string }> {
  const envHandle = process.env.ORCA_TERMINAL_HANDLE || ''
  const envIndex = process.env.ORCA_TERMINAL_INDEX || ''
  const worktreeLabel = worktree ? worktree.replace(/^id:/, '') : 'current'

  if (envIndex) {
    return { from: `@${envIndex}`, handle: envHandle || 'unknown', worktreeLabel }
  }

  if (envHandle) {
    try {
      const list = await client.call<RuntimeTerminalListResult>(
        'terminal.list',
        worktree ? { worktree } : undefined
      )
      const found = list.result.terminals.find((t) => t.handle === envHandle)
      if (found?.target) {
        return { from: found.target, handle: envHandle, worktreeLabel }
      }
    } catch {
      // Fallback
    }
    return { from: envHandle, handle: envHandle, worktreeLabel }
  }

  return { from: 'orca-cli', handle: 'caller', worktreeLabel }
}

export async function emitA2ATrace(
  client: HandlerContext['client'],
  args: {
    fromDisplay: string
    targetDisplay: string
    handle: string
    type: 'send' | 'message' | 'type' | 'keys'
    text?: string
  }
): Promise<void> {
  const fromIndex = parseTerminalIndex(args.fromDisplay)
  const toIndex = parseTerminalIndex(args.targetDisplay)
  await client
    .call<{ ok: boolean; id: string }>('terminal.a2aLink', {
      from: args.fromDisplay,
      to: args.targetDisplay,
      fromIndex,
      toIndex,
      type: args.type,
      text: args.text,
      timestamp: Date.now()
    })
    .catch(() => {
      // Best effort trace emission
    })
}

export const bridgeIdHandler: CommandHandler = async () => {
  const envIndex = process.env.ORCA_TERMINAL_INDEX
  if (envIndex) {
    console.log(`@${envIndex}`)
    return
  }
  const envHandle = process.env.ORCA_TERMINAL_HANDLE
  if (envHandle) {
    console.log(envHandle)
    return
  }
  console.log('@?')
}

export const bridgeResolveHandler: CommandHandler = async (ctx) => {
  const target = getOptionalStringFlag(ctx.flags, 'target') || ctx.rawArgs?.[0]
  const resolved = await resolveTargetAndHandle(target, ctx)
  if (ctx.json) {
    console.log(JSON.stringify(resolved))
  } else {
    console.log(resolved.handle)
  }
}

export const bridgeNameHandler: CommandHandler = async (ctx) => {
  const target = getOptionalStringFlag(ctx.flags, 'target') || ctx.rawArgs?.[0]
  const label = getOptionalStringFlag(ctx.flags, 'name') || ctx.rawArgs?.[1]
  if (!label) {
    throw new RuntimeClientError('invalid_argument', 'New label/name is required.')
  }
  const { handle } = await resolveTargetAndHandle(target, ctx)

  const result = await ctx.client.call<{ rename: RuntimeTerminalRename }>('terminal.rename', {
    terminal: handle,
    title: label
  })

  if (ctx.json) {
    console.log(JSON.stringify(result.result.rename))
  } else {
    console.log(`Renamed terminal ${handle} to "${label}".`)
  }
}

export const bridgeDoctorHandler: CommandHandler = async (ctx) => {
  const worktree = await getBrowserWorktreeSelector(ctx.flags, ctx.cwd, ctx.client)
  const sender = await resolveSenderIdentity(ctx.client, worktree)
  const listResult = await ctx.client.call<RuntimeTerminalListResult>(
    'terminal.list',
    worktree ? { worktree } : undefined
  )

  const report = {
    connected: true,
    sender,
    worktree: worktree ?? 'none',
    terminalCount: listResult.result.terminals.length,
    terminals: listResult.result.terminals.map((t) => ({
      target: t.target,
      handle: t.handle,
      label: t.label || t.title
    }))
  }

  if (ctx.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('Orca Terminal Bridge Doctor')
    console.log('---------------------------')
    console.log(`Sender Target:  ${sender.from}`)
    console.log(`Sender Handle:  ${sender.handle}`)
    console.log(`Worktree:       ${sender.worktreeLabel}`)
    console.log(`Total Panes:    ${report.terminalCount}`)
    console.log('Available Panes:')
    for (const t of report.terminals) {
      console.log(
        `  ${(t.target || '-').padEnd(6)} ${t.handle.padEnd(20)} ${t.label || '(untitled)'}`
      )
    }
    console.log('Status: OK')
  }
}

export const bridgeTraceHandler: CommandHandler = async (ctx) => {
  const target = getOptionalStringFlag(ctx.flags, 'target') || ctx.rawArgs?.[0]
  const text = getOptionalStringFlag(ctx.flags, 'text') ?? ctx.rawArgs?.slice(1).join(' ') ?? ''
  const customFrom = getOptionalStringFlag(ctx.flags, 'from')
  const typeFlag = getOptionalStringFlag(ctx.flags, 'type')
  const { targetDisplay, worktree } = await resolveTargetAndHandle(target, ctx)

  const sender = customFrom
    ? { from: customFrom, handle: 'custom', worktreeLabel: 'custom' }
    : await resolveSenderIdentity(ctx.client, worktree)

  const validTypes = ['send', 'message', 'type', 'keys'] as const
  const traceType = (validTypes as readonly string[]).includes(typeFlag ?? '')
    ? (typeFlag as 'send' | 'message' | 'type' | 'keys')
    : 'send'

  const fromIndex = parseTerminalIndex(sender.from)
  const toIndex = parseTerminalIndex(targetDisplay)

  const res = await ctx.client.call<{ ok: boolean; id: string }>('terminal.a2aLink', {
    from: sender.from,
    to: targetDisplay,
    fromIndex,
    toIndex,
    type: traceType,
    text: text || undefined,
    timestamp: Date.now()
  })

  if (ctx.json) {
    console.log(
      JSON.stringify({
        ok: true,
        id: res.result?.id,
        from: sender.from,
        to: targetDisplay,
        text: text || undefined
      })
    )
  } else {
    console.log(`Trace emitted: ${sender.from} -> ${targetDisplay}${text ? ` (${text})` : ''}`)
  }
}
