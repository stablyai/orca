export const ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'content-type': 'text/html; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff'
} as const

export type OrcaCloudCallbackOutcome =
  | { status: 'connected' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string }

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const CHECK_PATH = '<path d="m5 12 4 4L19 6"></path>'
const CROSS_PATH = '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>'

function callbackCopy(outcome: OrcaCloudCallbackOutcome): {
  title: string
  message: string
  detail?: string
} {
  if (outcome.status === 'connected') {
    return { title: 'Signed in to Orca', message: 'You can close this tab and return to the app.' }
  }
  if (outcome.status === 'cancelled') {
    return {
      title: 'Orca sign-in was cancelled',
      message: 'Orca stopped waiting for this sign-in. Return to Orca to sign in again.'
    }
  }
  return {
    title: 'Orca could not finish signing in',
    message: 'Return to Orca and try again.',
    detail: outcome.error
  }
}

export function orcaCloudCallbackPage(outcome: OrcaCloudCallbackOutcome): string {
  const copy = callbackCopy(outcome)
  const connected = outcome.status === 'connected'
  return ORCA_CLOUD_CALLBACK_PAGE_TEMPLATE.replace(
    '{{markClass}}',
    connected ? 'success-mark' : 'error-mark'
  )
    .replace('{{markPath}}', connected ? CHECK_PATH : CROSS_PATH)
    .replaceAll('{{title}}', escapeHtml(copy.title))
    .replace('{{message}}', escapeHtml(copy.message))
    .replace('{{detail}}', copy.detail ? `<p class="detail">${escapeHtml(copy.detail)}</p>` : '')
}

// The standalone loopback callback mirrors renderer tokens without loading external assets.
const ORCA_CLOUD_CALLBACK_PAGE_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>{{title}}</title>
    <style>
      :root {
        --background: #fff;
        --foreground: #0a0a0a;
        --muted-foreground: #737373;
        --border: #e5e5e5;
        --success: #15803d;
        --destructive: #e40014;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: #0a0a0a;
          --foreground: #fafafa;
          --muted-foreground: #a1a1a1;
          --border: rgb(255 255 255 / 0.07);
          --success: #86efac;
          --destructive: #ff6568;
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
      .success-mark,
      .error-mark {
        width: 44px;
        height: 44px;
        margin: 0 auto 20px;
        display: grid;
        place-items: center;
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--success);
      }
      .error-mark { color: var(--destructive); }
      .success-mark svg,
      .error-mark svg { width: 22px; height: 22px; }
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
      .detail {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="{{markClass}}" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          {{markPath}}
        </svg>
      </div>
      <h1>{{title}}</h1>
      <p>{{message}}</p>
      {{detail}}
    </main>
  </body>
</html>`
