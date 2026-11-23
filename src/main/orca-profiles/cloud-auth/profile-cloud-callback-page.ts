import type { ConnectCurrentOrcaProfileResult } from '../../../shared/orca-profiles/orca-profiles'

export const ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'content-type': 'text/html; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff'
} as const

// The standalone loopback callback mirrors renderer tokens without loading external assets.
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const CHECK_MARK = '<path d="m5 12 4 4L19 6"></path>'
const CROSS_MARK = '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>'

function pageStart(title: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --background: #fff;
        --foreground: #0a0a0a;
        --muted-foreground: #737373;
        --border: #e5e5e5;
        --success: #15803d;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: #0a0a0a;
          --foreground: #fafafa;
          --muted-foreground: #a1a1a1;
          --border: rgb(255 255 255 / 0.07);
          --success: #86efac;
        }
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        background: var(--background);
        color: var(--foreground);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0.01em;
      }
      main {
        width: min(440px, calc(100% - 48px));
        padding: 48px 0;
        text-align: center;
      }
      .mark {
        width: 44px;
        height: 44px;
        margin: 0 auto 20px;
        display: grid;
        place-items: center;
        border: 1px solid var(--border);
        border-radius: 999px;
      }
      .mark.success { color: var(--success); }
      .mark.failed { color: var(--muted-foreground); }
      .mark.waiting { border-top-color: var(--foreground); animation: spin 0.9s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .mark.waiting { animation: none; } }
      .mark svg { width: 22px; height: 22px; }
      h1 {
        margin: 0;
        font-size: 28px;
        font-weight: 650;
        line-height: 1.2;
        letter-spacing: -0.02em;
      }
      p {
        margin: 12px 0 0;
        color: var(--muted-foreground);
        font-size: 15px;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
`
}

function pageMain(
  heading: string,
  line: string | null,
  mark: 'success' | 'failed' | 'waiting' | 'neutral',
  className = ''
): string {
  const icon =
    mark === 'waiting' || mark === 'neutral'
      ? ''
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${mark === 'success' ? CHECK_MARK : CROSS_MARK}</svg>`
  return `    <main${className ? ` class="${className}"` : ''}>
      <div class="mark ${mark}" aria-hidden="true">${icon}</div>
      <h1>${escapeHtml(heading)}</h1>
${line === null ? '' : `      <p>${escapeHtml(line)}</p>\n`}    </main>
`
}

const PAGE_END = `  </body>
</html>`

/** A whole page with one heading; `heading` is escaped, though it should be a fixed string of ours. */
export function orcaCallbackSuccessPage(
  heading: string,
  line = 'You can close this tab and return to the app.'
): string {
  return `${pageStart(heading)}${pageMain(heading, line, 'success')}${PAGE_END}`
}

/**
 * A page sent in two parts: the neutral first part as soon as the browser is back, and the outcome
 * once the work it waits on is done, which hides the first part (no script runs on these pages).
 */
export const orcaCallbackReceivedPage = (): string =>
  `${pageStart('Orca')}${pageMain('Finishing sign-in…', null, 'waiting', 'received')}`

/** `ok: null` is no outcome yet, e.g. the tab stopped waiting while Orca still finishes. */
export function orcaCallbackOutcome(outcome: {
  ok: boolean | null
  heading: string
  line: string
}): string {
  const mark = outcome.ok === null ? 'neutral' : outcome.ok ? 'success' : 'failed'
  return `    <style>.received { display: none; }</style>
${pageMain(outcome.heading, outcome.line, mark)}${PAGE_END}`
}

export type OrcaCloudCallbackOutcome =
  | { status: 'connected' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string }

/** A connect that ended signed in (even through a newer tab) shows success; any other end but a failure is neutral. */
export function orcaCloudCallbackOutcomeOf(
  result: ConnectCurrentOrcaProfileResult
): OrcaCloudCallbackOutcome {
  if (result.status === 'failed') {
    return { status: 'failed', error: result.error }
  }
  return { status: result.auth.state === 'connected' ? 'connected' : 'cancelled' }
}

/** How an Orca sign-in tab ends once the app has exchanged (or failed to exchange) its code. */
export function orcaCloudCallbackOutcome(outcome: OrcaCloudCallbackOutcome): string {
  if (outcome.status === 'connected') {
    return orcaCallbackOutcome({
      ok: true,
      heading: 'Signed in to Orca',
      line: 'You can close this tab and return to the app.'
    })
  }
  if (outcome.status === 'cancelled') {
    return orcaCallbackOutcome({
      ok: null,
      heading: 'Orca sign-in was cancelled',
      line: 'Orca stopped waiting for this sign-in. Return to Orca to sign in again.'
    })
  }
  return orcaCallbackOutcome({
    ok: false,
    heading: 'Orca could not finish signing in',
    line: `Return to Orca and try again. (${outcome.error})`
  })
}
