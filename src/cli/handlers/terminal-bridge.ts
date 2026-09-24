import type {
  BrowserTabListResult,
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalSend
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getBrowserWorktreeSelector } from '../selectors'
import { formatTerminalHuman } from '../terminal-human-formatter'
import {
  handleBrowserKeys,
  handleBrowserMessage,
  handleBrowserRead,
  handleBrowserSend,
  handleBrowserType
} from './terminal-bridge-browser'
import {
  clearRead,
  formatBridgeList,
  KEY_MAP,
  markRead,
  requireRead
} from './terminal-bridge-guard'
import {
  bridgeDoctorHandler,
  bridgeIdHandler,
  bridgeNameHandler,
  bridgeResolveHandler,
  bridgeTraceHandler,
  emitA2ATrace,
  resolveSenderIdentity,
  resolveTargetAndHandle
} from './terminal-bridge-ops'

export const bridgeListHandler: CommandHandler = async (ctx) => {
  const worktree = await getBrowserWorktreeSelector(ctx.flags, ctx.cwd, ctx.client)
  const result = await ctx.client.call<RuntimeTerminalListResult>('terminal.list', {
    ...(worktree ? { worktree } : {}),
    limit: getOptionalPositiveIntegerFlag(ctx.flags, 'limit') ?? 100
  })
  let browserTabs: {
    browserPageId: string
    index?: number
    url: string
    title?: string
    active?: boolean
  }[] = []
  try {
    const bRes = await ctx.client.call<BrowserTabListResult>(
      'browser.tabList',
      worktree ? { worktree } : {}
    )
    browserTabs = bRes.result?.tabs ?? []
  } catch {
    // Non-blocking: tab list might not be active or supported
  }
  if (ctx.json) {
    console.log(JSON.stringify({ ...result.result, browserTabs }))
  } else {
    console.log(formatBridgeList(result.result, browserTabs))
  }
}

export const bridgeReadHandler: CommandHandler = async (ctx) => {
  const target = getOptionalStringFlag(ctx.flags, 'target') || ctx.rawArgs?.[0]
  const linesArg = ctx.rawArgs?.[1]
  const lines = linesArg && /^\d+$/.test(linesArg) ? Number.parseInt(linesArg, 10) : 50
  const screen = ctx.flags.get('screen') === true
  const isRaw = ctx.flags.get('raw') === true
  const isCompact = ctx.flags.get('compact') === true
  const resolved = await resolveTargetAndHandle(target, ctx)

  if (resolved.isBrowser) {
    await handleBrowserRead(resolved, ctx)
    return
  }

  const result = await ctx.client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
    terminal: resolved.handle,
    limit: lines,
    ...(screen ? { screen: true } : {})
  })

  markRead(resolved.handle)

  if (ctx.json) {
    console.log(JSON.stringify(result.result.terminal))
  } else {
    const output = result.result.terminal.tail
    if (output) {
      const text = await formatTerminalHuman(output, {
        raw: isRaw,
        compact: isCompact
      })
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
    }
  }
}

export const bridgeTypeHandler: CommandHandler = async (ctx) => {
  const target = getOptionalStringFlag(ctx.flags, 'target') || ctx.rawArgs?.[0]
  const text = getOptionalStringFlag(ctx.flags, 'text') ?? ctx.rawArgs?.slice(1).join(' ') ?? ''
  const noGuard = ctx.flags.get('no-read-guard') === true || ctx.flags.get('force') === true
  const resolved = await resolveTargetAndHandle(target, ctx)

  requireRead(resolved.handle, resolved.targetDisplay, noGuard)

  const sender = await resolveSenderIdentity(ctx.client, resolved.worktree)
  const emitTrace = (type: 'type', t: string) =>
    emitA2ATrace(ctx.client, {
      fromDisplay: sender.from,
      targetDisplay: resolved.targetDisplay,
      handle: resolved.handle,
      type,
      text: t
    })

  if (resolved.isBrowser) {
    await handleBrowserType(resolved, text, ctx, emitTrace)
    return
  }

  const result = await ctx.client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
    terminal: resolved.handle,
    text,
    enter: false,
    client: { id: 'orca-bridge', type: 'desktop' }
  })

  clearRead(resolved.handle)

  if (result.result.send.accepted) {
    await emitTrace('type', text)
  }

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
  const resolved = await resolveTargetAndHandle(target, ctx)

  requireRead(resolved.handle, resolved.targetDisplay, noGuard)

  const sender = await resolveSenderIdentity(ctx.client, resolved.worktree)
  const emitTrace = (type: 'send', t: string) =>
    emitA2ATrace(ctx.client, {
      fromDisplay: sender.from,
      targetDisplay: resolved.targetDisplay,
      handle: resolved.handle,
      type,
      text: t
    })

  if (resolved.isBrowser) {
    await handleBrowserSend(resolved, text, ctx, emitTrace)
    return
  }

  const result = await ctx.client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
    terminal: resolved.handle,
    text,
    enter: true,
    client: { id: 'orca-bridge', type: 'desktop' }
  })

  clearRead(resolved.handle)

  if (result.result.send.accepted) {
    await emitTrace('send', text)
  }

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
  const resolved = await resolveTargetAndHandle(target, ctx)

  requireRead(resolved.handle, resolved.targetDisplay, noGuard)

  const sender = await resolveSenderIdentity(ctx.client, resolved.worktree)
  const emitTrace = (type: 'message', t: string) =>
    emitA2ATrace(ctx.client, {
      fromDisplay: sender.from,
      targetDisplay: resolved.targetDisplay,
      handle: resolved.handle,
      type,
      text: t
    })

  if (resolved.isBrowser) {
    await handleBrowserMessage(resolved, text, ctx, emitTrace)
    return
  }

  const header = `[orca-bridge from:${sender.from} handle:${sender.handle} at:${sender.worktreeLabel} — reply via orca bridge msg ${sender.from} "<text>"]`
  const messageWithHeader = `${header} ${text}`

  const result = await ctx.client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
    terminal: resolved.handle,
    text: messageWithHeader,
    enter: true,
    client: { id: 'orca-bridge', type: 'desktop' }
  })

  clearRead(resolved.handle)

  if (result.result.send.accepted) {
    await emitTrace('message', text)
  }

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
  const resolved = await resolveTargetAndHandle(target, ctx)

  requireRead(resolved.handle, resolved.targetDisplay, noGuard)

  const sender = await resolveSenderIdentity(ctx.client, resolved.worktree)
  const emitTrace = (type: 'keys', t: string) =>
    emitA2ATrace(ctx.client, {
      fromDisplay: sender.from,
      targetDisplay: resolved.targetDisplay,
      handle: resolved.handle,
      type,
      text: t
    })

  if (resolved.isBrowser) {
    await handleBrowserKeys(resolved, keys, ctx, emitTrace)
    return
  }

  for (const key of keys) {
    const resolvedKey = KEY_MAP[key] ?? key
    const isEnter = resolvedKey === '\r'
    await ctx.client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
      terminal: resolved.handle,
      text: isEnter ? '' : resolvedKey,
      enter: isEnter,
      client: { id: 'orca-bridge', type: 'desktop' }
    })
  }

  clearRead(resolved.handle)
  await emitTrace('keys', keys.join(' '))

  if (ctx.json) {
    console.log(JSON.stringify({ accepted: true, keys }))
  }
}

export {
  bridgeDoctorHandler,
  bridgeIdHandler,
  bridgeNameHandler,
  bridgeResolveHandler,
  bridgeTraceHandler
}

export const BRIDGE_HANDLERS: Record<string, CommandHandler> = {
  'bridge list': bridgeListHandler,
  'bridge id': bridgeIdHandler,
  'bridge resolve': bridgeResolveHandler,
  'bridge read': bridgeReadHandler,
  'bridge type': bridgeTypeHandler,
  'bridge send': bridgeSendHandler,
  'bridge message': bridgeMessageHandler,
  'bridge keys': bridgeKeysHandler,
  'bridge name': bridgeNameHandler,
  'bridge trace': bridgeTraceHandler,
  'bridge doctor': bridgeDoctorHandler
}
