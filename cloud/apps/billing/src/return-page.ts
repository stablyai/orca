// Where Stripe Checkout and the Customer Portal send the browser back. It hands the user back to
// the desktop app through an orca:// link (opened at once, plus a button if the browser asks first).
// Static per outcome: query values only pick one of three fixed pages, nothing is reflected.

type Outcome = 'checkout-success' | 'checkout-cancel' | 'portal'

const COPY: Record<Outcome, { title: string; body: string; link: string }> = {
  'checkout-success': {
    title: 'Payment complete',
    body: 'Your team is on Orca Cloud. Head back to Orca to invite people and start a cloud workspace.',
    link: 'orca://billing/return?checkout=success'
  },
  'checkout-cancel': {
    title: 'Checkout canceled',
    body: 'Nothing was charged. You can pick a plan again from Orca any time.',
    link: 'orca://billing/return?checkout=cancel'
  },
  portal: {
    title: 'Billing updated',
    body: 'Your changes are saved. Orca picks them up when you switch back.',
    link: 'orca://billing/return?portal=return'
  }
}

export function returnOutcome(url: URL): Outcome {
  if (url.searchParams.get('checkout') === 'success') {
    return 'checkout-success'
  }
  if (url.searchParams.get('checkout') === 'cancel') {
    return 'checkout-cancel'
  }
  return 'portal'
}

const CHECK =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'

export function renderReturnPage(outcome: Outcome): Response {
  const copy = COPY[outcome]
  const success = outcome === 'checkout-success'
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="0;url=${copy.link}">
<title>${copy.title} · Orca</title>
<style>
  :root { --bg:#fafafa; --card:#fff; --fg:#0a0a0a; --muted:#6b6b6b; --border:#e5e5e5; --ok:#15803d; --okbg:#ecfdf3; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0b0b; --card:#161616; --fg:#f5f5f5; --muted:#a3a3a3; --border:#2a2a2a; --ok:#4ade80; --okbg:#0f2a1a; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
    font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width:min(26rem, calc(100vw - 2rem)); background:var(--card); border:1px solid var(--border); border-radius:16px;
    padding:2rem; text-align:center; box-shadow: 0 20px 60px rgba(0,0,0,.08); }
  .mark { width:44px; height:44px; margin:0 auto 1rem; border-radius:999px; display:grid; place-items:center;
    background:${success ? 'var(--okbg)' : 'transparent'}; color:var(--ok); border:1px solid ${success ? 'transparent' : 'var(--border)'}; }
  h1 { font-size:1.25rem; letter-spacing:-.01em; margin:0 0 .5rem; }
  p { margin:0 0 1.5rem; color:var(--muted); }
  a.button { display:inline-block; padding:.6rem 1.1rem; border-radius:8px; background:var(--fg); color:var(--bg);
    text-decoration:none; font-weight:500; }
  a.button:focus-visible { outline:3px solid color-mix(in oklab, var(--fg) 40%, transparent); outline-offset:2px; }
  small { display:block; margin-top:1rem; color:var(--muted); font-size:.8rem; }
</style>
</head>
<body>
<main>
  <div class="mark">${success ? CHECK : ''}</div>
  <h1>${copy.title}</h1>
  <p>${copy.body}</p>
  <a class="button" href="${copy.link}">Open Orca</a>
  <small>You can close this tab.</small>
</main>
</body>
</html>`
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // No scripts, no external loads; only inline styles.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    }
  })
}
