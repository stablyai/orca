export const ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'content-type': 'text/html; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff'
} as const

// Why: the loopback callback cannot load Orca's renderer bundle, so this
// standalone page mirrors its canonical light/dark tokens without external assets.
export const ORCA_CLOUD_CALLBACK_SUCCESS_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>Signed in to Orca</title>
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
      .success-mark {
        width: 44px;
        height: 44px;
        margin: 0 auto 20px;
        display: grid;
        place-items: center;
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--success);
      }
      .success-mark svg { width: 22px; height: 22px; }
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
    <main>
      <div class="success-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m5 12 4 4L19 6"></path>
        </svg>
      </div>
      <h1>Signed in to Orca</h1>
      <p>You can close this tab and return to the app.</p>
    </main>
  </body>
</html>`
