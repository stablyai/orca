import type {
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalRename,
  RuntimeTerminalSend
} from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getBrowserWorktreeSelector, resolveTerminalTarget } from '../selectors'
import {
  clearRead,
  formatBridgeList,
  KEY_MAP,
  markRead,
  requireRead
} from './terminal-bridge-guard'

async function resolveTargetAndHandle(
  targetArg: string | undefined,
  ctx: HandlerContext
): Promise<{ targetDisplay: string; handle: string; worktree: string | undefined }> {
  if (!targetArg) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Target terminal is required (e.g. @1, @2, or handle).'
    )
  }
  const worktree = await getBrowserWorktreeSelector(ctx.flags, ctx.cwd, ctx.client)
  const handle = await resolveTerminalTarget(targetArg, worktree, ctx.client)
  return { targetDisplay: targetArg, handle, worktree }
}

async function resolveSenderIdentity(
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

export const bridgeListHandler: CommandHandler = async (ctx) => {
  const worktree = await getBrowserWorktreeSelector(ctx.flags, ctx.cwd, ctx.client)
  const result = await ctx.client.call<RuntimeTerminalListResult>('terminal.list', {
    ...(worktree ? { worktree } : {}),
    limit: getOptionalPositiveIntegerFlag(ctx.flags, 'limit') ?? 100
  })
  printResult(result, ctx.json, (r) => formatBridgeList(r))
}

export const bridgeIdHandler: CommandHandler = async (ctx) => {
  const worktree = await getBrowserWorktreeSelector(ctx.flags, ctx.cwd, ctx.client)
  const sender = await resolveSenderIdentity(ctx.client, worktree)
  if (ctx.json) {
    console.log(JSON.stringify({ target: sender.from, handle: sender.handle }))
  } else {
    console.log(sender.from)
  }
}

export const bridgeResolveHandler: CommandHandler = async (ctx) => {
  const target = getOptionalStringFlag(ctx.flags, 'target') || ctx.rawArgs?.[0]
  const { handle } = await resolveTargetAndHandle(target, ctx)
  if (ctx.json) {
    console.log(JSON.stringify({ handle }))
  } else {
    console.log(handle)
  }
}

export const bridgeReadHandler: CommandHandler = async (ctx) => {
  const target = getOptionalStringFlag(ctx.flags, 'target') || ctx.rawArgs?.[0]
  const linesArg = ctx.rawArgs?.[1]
  const lines = linesArg && /^\d+$/.test(linesArg) ? Number.parseInt(linesArg, 10) : 50
  const screen = ctx.flags.get('screen') === true
  const { handle } = await resolveTargetAndHandle(target, ctx)

  const result = await ctx.client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
    terminal: handle,
    limit: lines,
    ...(screen ? { screen: true } : {})
  })

  markRead(handle)

  if (ctx.json) {
    console.log(JSON.stringify(result.result.terminal))
  } else {
    const output = result.result.terminal.tail
    if (output) {
      const text = Array.isArray(output) ? output.join('\n') : output
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
    }
  }
}

export const bridgeTypeHandler: CommandHandler = async (ctx) => {
  const target = getOptionalStringFlag(ctx.flags, 'target') || ctx.rawArgs?.[0]
  const text = getOptionalStringFlag(ctx.flags, 'text') ?? ctx.rawArgs?.slice(1).join(' ') ?? ''
  const noGuard = ctx.flags.get('no-read-guard') === true || ctx.flags.get('force') === true
  const { handle, targetDisplay } = await resolveTargetAndHandle(target, ctx)

  requireRead(handle, targetDisplay, noGuard)

  const result = await ctx.client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
    terminal: handle,
    text,
    enter: false,
    client: { id: 'orca-bridge', type: 'desktop' }
  })

  clearRead(handle)

  if (ctx.json) {
    console.log(JSON.stringify(result.result.send))
  } else if (!result.result.send.accepted) {
    throw new RuntimeClientError('internal_error', 'Terminal did not accept input')
  }
}

export const bridgeSendHandler: CommandHandler = async (ctx) => {
  const target = getOptionalStringFlag(ctx.flags, 'target') || ctx.rawArgs?.[0]
  const text = getOptionalStringFlag(ctx.flags, 'text') ?? ctx.rawArgs?.slice(1).join(' ') ?? ''
  const noGuard = ctx.flags.get('no-read-guard') === true || ctx.flags.get('force') === true
  const { handle, targetDisplay } = await resolveTargetAndHandle(target, ctx)

  requireRead(handle, targetDisplay, noGuard)

  const result = await ctx.client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
    terminal: handle,
    text,
    enter: true,
    client: { id: 'orca-bridge', type: 'desktop' }
  })

  clearRead(handle)

  if (ctx.json) {
    console.log(JSON.stringify(result.result.send))
  } else if (!result.result.send.accepted) {
    throw new RuntimeClientError('internal_error', 'Terminal did not accept input')
  }
}

export const bridgeMessageHandler: CommandHandler = async (ctx) => {
  const target = getOptionalStringFlag(ctx.flags, 'target') || ctx.rawArgs?.[0]
  const text = getOptionalStringFlag(ctx.flags, 'message') ?? ctx.rawArgs?.slice(1).join(' ') ?? ''
  const noGuard = ctx.flags.get('no-read-guard') === true || ctx.flags.get('force') === true
  const { handle, targetDisplay, worktree } = await resolveTargetAndHandle(target, ctx)

  requireRead(handle, targetDisplay, noGuard)

  const sender = await resolveSenderIdentity(ctx.client, worktree)
  const header = `[orca-bridge from:${sender.from} handle:${sender.handle} at:${sender.worktreeLabel} — reply via orca bridge msg ${sender.from} "<text>"]`
  const messageWithHeader = `${header} ${text}`

  const result = await ctx.client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
    terminal: handle,
    text: messageWithHeader,
    enter: true,
    client: { id: 'orca-bridge', type: 'desktop' }
  })

  clearRead(handle)

  if (ctx.json) {
    console.log(JSON.stringify(result.result.send))
  } else if (!result.result.send.accepted) {
    throw new RuntimeClientError('internal_error', 'Terminal did not accept message')
  }
}

export const bridgeKeysHandler: CommandHandler = async (ctx) => {
  const target = getOptionalStringFlag(ctx.flags, 'target') || ctx.rawArgs?.[0]
  const keys = ctx.rawArgs?.slice(1) ?? []
  if (keys.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      'At least one key is required (e.g. Enter, Escape, C-c).'
    )
  }
  const noGuard = ctx.flags.get('no-read-guard') === true || ctx.flags.get('force') === true
  const { handle, targetDisplay } = await resolveTargetAndHandle(target, ctx)

  requireRead(handle, targetDisplay, noGuard)

  for (const key of keys) {
    const resolvedKey = KEY_MAP[key] ?? key
    const isEnter = resolvedKey === '\r'
    await ctx.client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
      terminal: handle,
      text: isEnter ? '' : resolvedKey,
      enter: isEnter,
      client: { id: 'orca-bridge', type: 'desktop' }
    })
  }

  clearRead(handle)

  if (ctx.json) {
    console.log(JSON.stringify({ accepted: true, keys }))
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

export const BRIDGE_HANDLERS: Record<string, CommandHandler> = {
  'bridge list': bridgeListHandler,
  'bridge id': bridgeIdHandler,
  'bridge resolve': bridgeResolveHandler,
  'bridge read': bridgeReadHandler,
  'bridge type': bridgeTypeHandler,
  'bridge send': bridgeSendHandler,
  'bridge message': bridgeMessageHandler,
  'bridge msg': bridgeMessageHandler,
  'bridge keys': bridgeKeysHandler,
  'bridge name': bridgeNameHandler,
  'bridge doctor': bridgeDoctorHandler
}
