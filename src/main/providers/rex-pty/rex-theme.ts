import { rexTerminalSize } from './rex-rpc-schema'
import {
  cssColorToOscRgb,
  type TerminalOscColorQueryReplyColors
} from '../../../shared/terminal/protocol/queries/terminal-osc-color-reply'
import {
  normalizeColorQueryReplyColors,
  resolvePtyOwnerColorQueryColors
} from '../../../shared/terminal/pty/ingress/pty-owner-color-query-colors'
import {
  parseXColorSpec,
  terminalViewRgbToCssHex
} from '../../../shared/terminal/protocol/queries/terminal-view-attributes'
import type { RexFreshSession } from './rex-fresh-session'
import type { PtyStartupIngressIntent } from '../../../shared/terminal/pty/ingress/pty-startup-ingress-intent'

export type RexThemeColors = { foreground: string; background: string }

export function rexThemeColors(value: unknown): RexThemeColors | undefined {
  const colors = normalizeColorQueryReplyColors(value)
  if (!colors) {
    return undefined
  }
  const fg = parseXColorSpec(cssColorToOscRgb(colors.foreground) ?? '')
  const bg = parseXColorSpec(cssColorToOscRgb(colors.background) ?? '')
  if (!fg || !bg) {
    return undefined
  }
  return { foreground: terminalViewRgbToCssHex(fg), background: terminalViewRgbToCssHex(bg) }
}

export function resolveRexStartupTheme(
  host: TerminalOscColorQueryReplyColors | undefined,
  intent: PtyStartupIngressIntent | undefined
): RexThemeColors | undefined {
  return rexThemeColors(
    resolvePtyOwnerColorQueryColors(host, intent?.colors, intent?.launcherColors)
  )
}

/** One outstanding theme update per live block. Last update wins without retrying a lost RPC. */
export class RexThemeController {
  private host?: RexThemeColors
  private readonly requests = new WeakMap<RexFreshSession, Promise<void>>()

  current(): RexThemeColors | undefined {
    return this.host
  }

  update(colors: TerminalOscColorQueryReplyColors, sessions: Iterable<RexFreshSession>): void {
    const valid = rexThemeColors(colors)
    if (!valid) {
      return
    }
    this.host = valid
    for (const session of sessions) {
      if (!session.record.launcherTheme) {
        void this.apply(session).catch(() => undefined)
      }
    }
  }

  apply(session: RexFreshSession): Promise<void> {
    const existing = this.requests.get(session)
    if (existing) {
      return existing
    }
    const pending = this.push(session).finally(() => this.requests.delete(session))
    this.requests.set(session, pending)
    return pending
  }

  private async push(session: RexFreshSession): Promise<void> {
    while (
      !session.closing &&
      !session.lost &&
      session.exitCode === undefined &&
      !session.record.adopted
    ) {
      const theme = session.record.launcherTheme ?? this.host
      if (!theme) {
        return
      }
      const size = await session.control.call(
        'com.superlogical.terminal.size',
        {
          session_id: session.sessionId,
          block_id: session.blockId,
          args: {}
        },
        rexTerminalSize.parse
      )
      if (
        size.owner !== session.clientId ||
        session.closing ||
        session.lost ||
        session.exitCode !== undefined
      ) {
        return
      }
      await session.control.call('com.superlogical.terminal.set_theme', {
        session_id: session.sessionId,
        block_id: session.blockId,
        args: theme
      })
      if (theme === (session.record.launcherTheme ?? this.host)) {
        return
      }
    }
  }
}
