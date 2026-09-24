import type {
  BrowserClickResult,
  BrowserEvalResult,
  BrowserFillResult,
  BrowserSnapshotResult,
  BrowserTabShowResult,
  BrowserTypeResult
} from '../../shared/runtime-types'
import type { HandlerContext } from '../dispatch'
import { formatSnapshot } from '../format'
import { RuntimeClientError } from '../runtime-client'
import type { ResolvedBrowserTarget } from '../selectors'
import { clearRead, markRead } from './terminal-bridge-guard'

type BrowserTargetResolution = {
  targetDisplay: string
  handle: string
  worktree: string | undefined
  browserInfo?: ResolvedBrowserTarget
}

export async function handleBrowserRead(
  resolved: BrowserTargetResolution,
  ctx: HandlerContext
): Promise<void> {
  markRead(resolved.handle)
  try {
    const snap = await ctx.client.call<BrowserSnapshotResult>('browser.snapshot', {
      page: resolved.handle
    })
    if (ctx.json) {
      console.log(JSON.stringify(snap.result))
    } else {
      const titleStr = resolved.browserInfo?.title ? `${resolved.browserInfo.title} ` : ''
      const urlStr = resolved.browserInfo?.url ? `(${resolved.browserInfo.url})` : ''
      console.log(`[Browser Tab ${resolved.targetDisplay}] ${titleStr}${urlStr}`.trim())
      console.log(formatSnapshot(snap.result))
    }
  } catch {
    const tabShow = await ctx.client.call<BrowserTabShowResult>('browser.tabShow', {
      page: resolved.handle
    })
    if (ctx.json) {
      console.log(JSON.stringify(tabShow.result))
    } else {
      console.log(
        `[Browser Tab ${resolved.targetDisplay}] ${tabShow.result.tab.title} (${tabShow.result.tab.url})`
      )
    }
  }
}

export async function handleBrowserType(
  resolved: BrowserTargetResolution,
  text: string,
  ctx: HandlerContext,
  emitTrace: (type: 'type', text: string) => Promise<void>
): Promise<void> {
  clearRead(resolved.handle)
  await ctx.client.call<BrowserTypeResult>('browser.type', {
    text,
    page: resolved.handle
  })
  await emitTrace('type', text)
  if (ctx.json) {
    console.log(JSON.stringify({ ok: true, target: resolved.targetDisplay, typed: text }))
  } else {
    console.log(`[${resolved.targetDisplay}] Typed: ${text}`)
  }
}

export async function handleBrowserSend(
  resolved: BrowserTargetResolution,
  text: string,
  ctx: HandlerContext,
  emitTrace: (type: 'send', text: string) => Promise<void>
): Promise<void> {
  clearRead(resolved.handle)
  const trimmed = text.trim()
  let outcome = ''

  if (
    /^(?:goto|open)\s+/i.test(trimmed) ||
    /^https?:\/\//i.test(trimmed) ||
    /^about:/i.test(trimmed)
  ) {
    const destUrl = trimmed.replace(/^(?:goto|open)\s+/i, '').trim()
    await ctx.client.call('browser.openUrl', {
      url: destUrl,
      worktree: resolved.worktree
    })
    outcome = `Navigated to ${destUrl}`
  } else if (/^click\s+/i.test(trimmed)) {
    const selector = trimmed.slice(6).trim()
    const clickRes = await ctx.client.call<BrowserClickResult>('browser.click', {
      element: selector,
      page: resolved.handle
    })
    outcome = `Clicked ${clickRes.result.clicked}`
  } else if (/^fill\s+/i.test(trimmed)) {
    const fillMatch = /^fill\s+(\S+)\s+(.+)$/i.exec(trimmed)
    if (!fillMatch) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Usage: bridge send @b1 "fill <selector> <value>"'
      )
    }
    const [, element, val] = fillMatch
    const fillRes = await ctx.client.call<BrowserFillResult>('browser.fill', {
      element,
      value: val,
      page: resolved.handle
    })
    outcome = `Filled ${fillRes.result.filled}`
  } else if (/^type\s+/i.test(trimmed)) {
    const textToType = trimmed.slice(5)
    await ctx.client.call<BrowserTypeResult>('browser.type', {
      text: textToType,
      page: resolved.handle
    })
    outcome = 'Typed text'
  } else if (/^(?:eval|exec)\s+/i.test(trimmed)) {
    const script = trimmed.replace(/^(?:eval|exec)\s+/i, '').trim()
    const evalRes = await ctx.client.call<BrowserEvalResult>('browser.eval', {
      script,
      page: resolved.handle
    })
    outcome = evalRes.result?.result ?? 'Executed script'
  } else if (trimmed === 'reload') {
    await ctx.client.call('browser.reload', { page: resolved.handle })
    outcome = `Reloaded ${resolved.targetDisplay}`
  } else if (trimmed === 'back') {
    await ctx.client.call('browser.back', { page: resolved.handle })
    outcome = 'Navigated back'
  } else if (trimmed === 'forward') {
    await ctx.client.call('browser.forward', { page: resolved.handle })
    outcome = 'Navigated forward'
  } else {
    try {
      const evalRes = await ctx.client.call<BrowserEvalResult>('browser.eval', {
        script: trimmed,
        page: resolved.handle
      })
      outcome = evalRes.result?.result ?? 'Executed script'
    } catch {
      await ctx.client.call<BrowserTypeResult>('browser.type', {
        text,
        page: resolved.handle
      })
      outcome = `Typed text`
    }
  }

  await emitTrace('send', text)

  if (ctx.json) {
    console.log(JSON.stringify({ ok: true, target: resolved.targetDisplay, outcome }))
  } else {
    console.log(`[${resolved.targetDisplay}] ${outcome}`)
  }
}

export async function handleBrowserMessage(
  resolved: BrowserTargetResolution,
  text: string,
  ctx: HandlerContext,
  emitTrace: (type: 'message', text: string) => Promise<void>
): Promise<void> {
  clearRead(resolved.handle)
  const destUrl =
    /^https?:\/\//i.test(text.trim()) || /^about:/i.test(text.trim())
      ? text.trim()
      : `https://www.google.com/search?q=${encodeURIComponent(text.trim())}`
  await ctx.client.call('browser.openUrl', {
    url: destUrl,
    worktree: resolved.worktree
  })
  await emitTrace('message', destUrl)
  if (ctx.json) {
    console.log(JSON.stringify({ ok: true, target: resolved.targetDisplay, navigated: destUrl }))
  } else {
    console.log(`[${resolved.targetDisplay}] Navigated to ${destUrl}`)
  }
}

export async function handleBrowserKeys(
  resolved: BrowserTargetResolution,
  keys: string[],
  ctx: HandlerContext,
  emitTrace: (type: 'keys', text: string) => Promise<void>
): Promise<void> {
  clearRead(resolved.handle)
  for (const key of keys) {
    await ctx.client.call('browser.keypress', {
      key,
      page: resolved.handle
    })
  }
  await emitTrace('keys', keys.join(' '))
  if (ctx.json) {
    console.log(JSON.stringify({ accepted: true, keys }))
  } else {
    console.log(`[${resolved.targetDisplay}] Sent keys: ${keys.join(' ')}`)
  }
}
