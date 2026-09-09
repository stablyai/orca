// Why: web.whatsapp.com UA-sniffs and shows its "update Chrome" wall whenever the Electron/app
// tokens are present, even alongside a current Chrome token. The fix is host-scoped, mirroring
// the Google auth-host Firefox switch: the session-wide UA deliberately keeps the Electron
// tokens (see browser-session-ua.ts — a Chrome-shaped app-wide identity is what Cloudflare
// Turnstile rejects), so only WhatsApp Web sees the session identity minus those tokens.
// Client hints stay untouched: Chromium's real sec-ch-ua brands carry no Electron entry, so
// they agree with the stripped Chrome-format UA.

// Why: exact hostname match — www/faq.whatsapp.com are ordinary sites that accept the stock UA,
// and only the web client gates on it.
const WHATSAPP_WEB_HOST = 'web.whatsapp.com'

export function isWhatsAppWebUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname.toLowerCase() === WHATSAPP_WEB_HOST
  } catch {
    return false
  }
}

// Why: drop ONLY the app and Electron product tokens (case-insensitive — dev builds emit a
// lowercase app token); platform, Chrome build, and WebKit/Safari tokens must stay byte-identical
// to the engine's own identity or the UA stops matching the real Chromium underneath.
export function whatsAppCompatUserAgent(userAgent: string): string {
  return userAgent.replace(/\s?\bOrca\/\S+/i, '').replace(/\s?\bElectron\/\S+/i, '')
}
