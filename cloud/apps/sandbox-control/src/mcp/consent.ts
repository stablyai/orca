// The OAuth consent page for MCP clients. Server-rendered, no script (CSP script-src 'none'),
// cannot be framed, every interpolated value escaped.
//
// Switching to login.onorca.dev later: once the login service accepts a hosted redirect for this
// Worker (a first-party client such as `orca-cloud-mcp` with redirect_uri
// <origin>/oauth/login-callback), GET /oauth/authorize can stash the validated request (signed
// cookie or a short D1 row), send the browser to the login service's /v1/desktop/auth/authorize with
// its own PKCE pair, exchange the returned code at /v1/desktop/auth/session for the user's identity
// and org role, and render this page with an Approve button only. The credential field and
// resolveGrantor() in oauth.ts are the only parts that go away; codes, tokens and scopes stay.
export const CSRF_COOKIE = '__Host-orca_mcp_csrf'

export function csrfCookie(value: string): string {
  return `${CSRF_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800`
}

export type ConsentView = {
  clientName: string | null
  clientId: string
  redirectHost: string
  redirectIsLocal: boolean
  registeredAt: number
  scopes: { scope: string; label: string }[]
  hidden: Record<string, string>
  error: string | null
}

function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#1b1b1a;--muted:#6b6b66;--line:#e3e3df;--accent:#1b1b1a;--accent-fg:#fff;--warn:#8a5a00;--warn-bg:#fff6e0;--err:#a1260d;--err-bg:#fdecea;--focus:#3b6cf6}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1c1c1b;--fg:#ededea;--muted:#a0a09a;--line:#2f2f2d;--accent:#ededea;--accent-fg:#121211;--warn:#f2c25b;--warn-bg:#2b2412;--err:#ff8a73;--err-bg:#2e1712}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:19px;line-height:1.3;margin:0 0 6px}
p{margin:0 0 14px}
.muted{color:var(--muted);font-size:13px}
.brand{font-weight:600;font-size:13px;letter-spacing:.02em;color:var(--muted);margin-bottom:18px}
ul{list-style:none;padding:0;margin:0 0 18px;border:1px solid var(--line);border-radius:10px}
li{border-top:1px solid var(--line)}li:first-child{border-top:0}
li label{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;cursor:pointer}
input[type=checkbox]{margin-top:3px;width:16px;height:16px;accent-color:var(--accent)}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.field{display:block;font-weight:600;font-size:13px;margin:0 0 6px}
input[type=password]{width:100%;font:14px ui-monospace,SFMono-Regular,Menlo,monospace;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.note{padding:10px 12px;border-radius:8px;font-size:13px;margin:0 0 14px}
.warn{background:var(--warn-bg);color:var(--warn)}
.err{background:var(--err-bg);color:var(--err)}
.row{display:flex;gap:10px;margin-top:18px}
button{flex:1;font:inherit;font-weight:600;padding:10px 14px;border-radius:9px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
@media (prefers-reduced-motion:no-preference){button{transition:opacity .12s}button:hover{opacity:.88}}
`

function securityHeaders(formAction: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // Clickjacking: never framed. form-action also covers the 302 to the client after submit.
    'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${formAction}`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin'
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
}

export function consentPage(view: ConsentView, csrf: string, formAction: string, status = 200): Response {
  const name = view.clientName ?? 'An unnamed application'
  const hidden = Object.entries(view.hidden)
    .map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}">`)
    .join('')
  const scopes = view.scopes
    .map(
      ({ scope, label }) =>
        `<li><label><input type="checkbox" name="grant" value="${esc(scope)}" checked><span>${esc(label)}<br><code>${esc(scope)}</code></span></label></li>`
    )
    .join('')
  const body =
    `<div class="brand">ORCA CLOUD</div>` +
    `<h1>Allow <span>${esc(name)}</span> to use your Orca Cloud account?</h1>` +
    `<p class="muted">It will act as you through the Orca Cloud MCP server. After approving you are sent to <b>${esc(view.redirectHost)}</b>${view.redirectIsLocal ? ' (an app on this computer)' : ''}.</p>` +
    (view.clientName ? '' : `<div class="note warn" role="note">This application did not give a name. Only continue if you just started connecting it yourself.</div>`) +
    (view.error ? `<div class="note err" role="alert">${esc(view.error)}</div>` : '') +
    `<form method="post" action="/oauth/authorize">${hidden}` +
    `<p class="field" id="scopes-label">It will be able to</p><ul aria-labelledby="scopes-label">${scopes}</ul>` +
    `<label class="field" for="credential">Approval code or API key</label>` +
    `<input type="password" id="credential" name="credential" autocomplete="off" spellcheck="false" required aria-describedby="credential-help" placeholder="orca_ap_… or orca_sk_…">` +
    `<p class="muted" id="credential-help" style="margin-top:6px">In Orca, open Settings → Orca Cloud → API access and choose <b>Approve an app</b> for a one-time code, or paste one of your API keys. The app gets at most what that key may do; the code or key itself is never shared with it.</p>` +
    `<div class="row"><button type="submit" name="decision" value="deny" formnovalidate>Cancel</button><button class="primary" type="submit" name="decision" value="approve">Approve</button></div>` +
    `</form>` +
    `<p class="muted" style="margin:16px 0 0">Client <code>${esc(view.clientId)}</code></p>`
  const headers = new Headers(securityHeaders(formAction))
  headers.append('set-cookie', csrfCookie(csrf))
  return new Response(page(`Allow ${name}? · Orca Cloud`, body), { status, headers })
}

export function errorPage(title: string, text: string, status: number): Response {
  return new Response(page(`${title} · Orca Cloud`, `<div class="brand">ORCA CLOUD</div><h1>${esc(title)}</h1><p>${esc(text)}</p>`), {
    status,
    headers: securityHeaders('')
  })
}
