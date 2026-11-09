// Branded pages the share gateway answers with instead of the app: asleep (wake), waking, ended,
// team-only, nothing listening. Self-contained HTML (no external assets), light + dark from the
// visitor's system setting, reduced-motion aware, keyboard and screen-reader friendly.

export type SharePageKind =
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'gone'
  | 'team_signin'
  | 'team_forbidden'
  | 'asleep'
  | 'asleep_no_wake'
  | 'waking'
  | 'no_listener'
  | 'unreachable'

/** What the page's one control does; `poll` pages also re-check on their own. */
type PageAction = 'wake' | 'reload' | 'open_in_orca' | 'none'
type PageCopy = { status: number; title: string; body: string; action: PageAction; poll: boolean }

function copy(kind: SharePageKind, port: number | null): PageCopy {
  const portText = port === null ? 'this port' : `port ${port}`
  const page = (status: number, title: string, body: string, action: PageAction = 'none', poll = false): PageCopy => ({
    status,
    title,
    body,
    action,
    poll
  })
  switch (kind) {
    case 'not_found':
      return page(404, 'This link doesn’t work', 'Check that the whole link was copied, or ask the person who shared it for a new one.')
    case 'expired':
      return page(410, 'This link has expired', 'Share links stop working after the time the owner chose. Ask them for a new link.')
    case 'revoked':
      return page(410, 'This link was turned off', 'The owner stopped sharing this preview. Ask them to share it again if you still need it.')
    case 'gone':
      return page(410, 'This workspace no longer exists', 'The workspace behind this link was deleted, so there is nothing to show.')
    case 'team_signin':
      return page(401, 'Open this preview in Orca', 'It’s shared with the owner’s team. Orca signs you in, then opens the preview in your browser.', 'open_in_orca')
    case 'team_forbidden':
      return page(403, 'You don’t have access', 'This preview is shared with the owner’s team, and your Orca account isn’t on it.')
    case 'asleep':
      return page(503, 'This workspace is asleep', 'Waking it usually takes under a minute. This page reloads when the workspace is up.', 'wake')
    case 'asleep_no_wake':
      return page(503, 'This workspace is asleep', 'The owner needs to open it in Orca. This page reloads when the workspace is up.', 'reload', true)
    case 'waking':
      return page(503, 'Waking the workspace…', 'This page reloads when the workspace is up.', 'none', true)
    case 'no_listener':
      return page(502, `Nothing is running on ${portText}`, `The workspace is up, but nothing is listening on ${portText}. Ask whoever shared this link to start it.`, 'reload', true)
    case 'unreachable':
      return page(502, 'The preview isn’t responding', 'The workspace is up, but its preview service didn’t answer.', 'reload')
  }
}

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--fg:#17171a;--muted:#5d5d66;--line:#e3e3e8;--btn:#17171a;--btn-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f12;--card:#18181c;--fg:#ededf0;--muted:#a0a0ab;--line:#2a2a31;--btn:#ededf0;--btn-fg:#17171a}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 28px 26px}
.brand{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px;font-weight:600;margin:0 0 20px}
.brand svg{flex:none}
h1{font-size:20px;line-height:1.3;margin:0 0 8px;font-weight:650;letter-spacing:-.01em}
h1:focus{outline:none}
p{margin:0;color:var(--muted)}
.actions{margin-top:22px;display:flex;align-items:center;gap:12px;min-height:40px}
.button{appearance:none;border:0;border-radius:9px;padding:10px 16px;font:inherit;font-weight:600;background:var(--btn);color:var(--btn-fg);cursor:pointer;text-decoration:none;display:inline-block}
.button:hover{opacity:.88}
.button:focus-visible{outline:2px solid var(--fg);outline-offset:3px}
.button[hidden]{display:none}
.status{font-size:13px;color:var(--muted)}
.aside{margin-top:14px;font-size:13px;color:var(--muted)}
.aside a{color:var(--fg)}
.aside a:focus-visible{outline:2px solid var(--fg);outline-offset:2px;border-radius:2px}
.spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--fg);animation:spin .8s linear infinite;flex:none}
.spinner[hidden]{display:none}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.spinner{animation:pulse 1.6s ease-in-out infinite;border-color:var(--fg)}}
`

const LOGO = `<svg width="28" height="18" viewBox="0 0 318.6 202.67" aria-hidden="true"><path transform="translate(-6.67 -70.67)" fill="currentColor" d="m 177.81311,248.33334 c 23.82304,-41.29793 40.54045,-66.84626 49.51207,-75.66667 6.81685,-6.70196 10.07373,-8.7374 20.07265,-12.54475 34.57822,-13.16655 61.04674,-26.78733 72.37222,-37.24295 9.62924,-8.88966 9.34286,-9.01142 -23.43671,-9.964 -35.71756,-1.03796 -43.72989,0.42119 -62.17546,11.323 -16.72118,9.88265 -34.20103,30.11225 -42.74704,49.47157 -2.57353,5.82985 -14.81294,44.3056 -27.96399,87.90747 -2.86036,9.48343 -3.02466,11.71633 -0.86213,11.71633 0.44382,0 7.29659,-11.25 15.22839,-25 z m -65.14644,-8.32267 C 120,239.3326 130.5,237.50979 136,235.95998 c 5.5,-1.5498 12.25,-3.13783 15,-3.52895 2.75,-0.39111 5,-0.95485 5,-1.25275 0,-0.29789 2.15135,-7.58487 4.78078,-16.19328 8.49209,-27.80201 12.21334,-40.41629 21.13747,-71.65166 4.81891,-16.86667 11.23502,-39.185 14.25802,-49.596301 5.12803,-17.66103 5.74763,-23.07037 2.64253,-23.07037 -1.84887,0 -4.07048,6.908293 -16.72243,52.000001 -21.78975,77.65896 -20.80806,74.74393 -26.84794,79.72251 -7.5925,6.25838 -25.03916,14.82524 -36.10856,17.73044 -17.0947,4.48656 -33.410599,3.86724 -53.116765,-2.01622 -18.569242,-5.54403 -23.142662,-5.80284 -33.639754,-1.9037 -5.875424,2.18242 -9.864152,5.04363 -16.716684,11.99127 -4.95,5.0187 -9.0000001,10.02884 -9.0000001,11.13364 0,1.75174 5.9276921,2.00299 46.3333351,1.96383 25.483334,-0.0247 52.333338,-0.59969 59.666668,-1.27777 z M 252.69513,104.63708 c 12.18267,-3.48651 15.77304,-7.895503 9.63821,-11.835773 -10.19296,-6.546726 -36.19849,-1.77301 -41.19436,7.561863 -1.2556,2.3461 -0.98698,3.2037 1.68353,5.375 2.69471,2.19098 4.59991,2.47691 12.53928,1.88189 5.14899,-0.3859 12.94899,-1.72824 17.33334,-2.98298 z"/></svg>`

/**
 * The page's behaviour. Wake POSTs `__orca/wake` (custom header: a cross-site form can't send it,
 * so no CSRF), then status is polled until the workspace is up and the page reloads. Polling backs
 * off on errors, pauses in hidden tabs, stops after 10 minutes, and a reload counter in
 * sessionStorage stops a ready-but-still-failing preview from reloading in a loop.
 */
function script(base: string, kind: SharePageKind, poll: boolean): string {
  return `(function(){
var base=${JSON.stringify(base).replace(/</g, '\\u003c')},kind=${JSON.stringify(kind)},poll=${poll ? 'true' : 'false'};
var h1=document.getElementById('t'),body=document.getElementById('b'),btn=document.getElementById('act'),status=document.getElementById('status'),spin=document.getElementById('spin'),elapsed=document.getElementById('elapsed');
var started=Date.now(),delay=2000,timer=null,LIMIT=600000,key='orca-share-reloads:'+base,spoken='';
function say(t){if(status&&t!==spoken){spoken=t;status.textContent=t}}
function tick(){if(elapsed){elapsed.textContent=kind==='waking'?Math.round((Date.now()-started)/1000)+'s':''}}
function reloads(){try{var r=JSON.parse(sessionStorage.getItem(key)||'null');return r&&Date.now()-r.at<60000?r.n:0}catch(e){return 0}}
function reload(){try{sessionStorage.setItem(key,JSON.stringify({n:reloads()+1,at:Date.now()}))}catch(e){}location.reload()}
function idle(label){if(spin){spin.hidden=true}if(elapsed){elapsed.textContent=''}if(btn){btn.hidden=false;btn.disabled=false;if(label){btn.textContent=label}btn.focus()}}
function giveUp(text){clearTimeout(timer);timer=null;poll=false;say(text);idle('Try again')}
function schedule(ms){clearTimeout(timer);timer=document.hidden?null:setTimeout(check,ms)}
function check(){
if(Date.now()-started>LIMIT){giveUp('Still not ready. Try again in a little while.');return}
tick();
fetch(base+'__orca/status'+(kind==='no_listener'?'?probe=1':''),{cache:'no-store'}).then(function(r){
if(!r.ok||(r.headers.get('content-type')||'').indexOf('application/json')<0){throw new Error('bad')}return r.json()}).then(function(s){
delay=2000;
if(s.state==='archived'){reload();return}
if(s.state==='ready'){
if(kind==='no_listener'){if(s.listening){if(reloads()<3){reload()}else{giveUp('The port answers, but the preview isn’t loading.')}return}schedule(5000);return}
if(reloads()>=3){giveUp('The workspace is up, but the preview isn’t loading.');return}reload();return}
if(s.state==='unavailable'){giveUp('The workspace couldn’t start. Try again later.');return}
if(s.state==='sleeping'&&kind==='waking'&&Date.now()-started>65000){wake();return}
schedule(2000)
}).catch(function(){delay=Math.min(delay*2,15000);schedule(delay)})}
function wake(){
started=Date.now();kind='waking';poll=true;
try{sessionStorage.removeItem(key)}catch(e){}
if(h1){h1.textContent='Waking the workspace…';h1.focus()}
if(body){body.textContent='This page reloads when the workspace is up.'}
if(btn){btn.hidden=true}if(spin){spin.hidden=false}say('Starting…');tick();
fetch(base+'__orca/wake',{method:'POST',headers:{'x-orca-wake':'1'}}).then(function(r){
var json=(r.headers.get('content-type')||'').indexOf('application/json')>=0;
return (json?r.json():Promise.resolve({})).then(function(b){return{ok:r.ok,b:b}})}).then(function(a){
if(!a.ok){giveUp(a.b&&a.b.reason==='not_allowed'?'Only the owner can wake this workspace.':'The workspace couldn’t be woken. Try again later.');return}
schedule(1500)}).catch(function(){giveUp('Couldn’t reach Orca. Check your connection and try again.')})}
document.addEventListener('visibilitychange',function(){if(!document.hidden&&poll&&!timer){schedule(0)}});
if(btn){btn.addEventListener('click',function(){
if(btn.getAttribute('data-action')==='wake'||kind==='waking'){wake()}else{reload()}})}
if(poll){schedule(kind==='waking'?1500:4000)}
if(kind==='waking'){say('Starting…');tick()}
if(kind==='no_listener'){say('Checking for it every few seconds.')}
})()`
}

/** `base` is the link's root (`/s/<token>/` or `/`); `token` feeds the "Open in Orca" link. */
export function sharePage(kind: SharePageKind, options: { port?: number | null; base?: string; token?: string } = {}): Response {
  const { status, title, body, action, poll } = copy(kind, options.port ?? null)
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const scripted = options.base !== undefined && (action === 'wake' || action === 'reload' || poll)
  const button = (label: string, act: string, hidden = false) =>
    `<button id="act" class="button" type="button" data-action="${act}"${hidden ? ' hidden' : ''}>${label}</button>`
  const controls =
    action === 'wake'
      ? `${button('Wake workspace', 'wake')}<span id="spin" class="spinner" hidden aria-hidden="true"></span>`
      : action === 'reload'
        ? `${button('Reload', 'reload')}<span id="spin" class="spinner" hidden aria-hidden="true"></span>`
        : action === 'open_in_orca' && options.token
          ? `<a class="button" href="orca://cloud-share/${escapeHtml(options.token)}">Open in Orca</a>`
          : kind === 'waking'
            ? `${button('Try again', 'wake', true)}<span id="spin" class="spinner" aria-hidden="true"></span>`
            : ''
  const actions = controls
    ? `<div class="actions">${controls}<span id="status" class="status" role="status" aria-live="polite"></span><span id="elapsed" class="status" aria-hidden="true"></span></div>`
    : ''
  const aside =
    action === 'open_in_orca'
      ? '<p class="aside">Don’t have Orca? <a href="https://www.onorca.dev/">Get Orca</a>, or ask the owner for a public link.</p>'
      : ''
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} · Orca</title><style>${STYLE}</style></head>
<body><main aria-labelledby="t"><div class="brand">${LOGO}<span>Orca preview</span></div><h1 id="t" tabindex="-1">${escapeHtml(title)}</h1><p id="b">${escapeHtml(body)}</p>${actions}${aside}</main>${
    scripted ? `<script nonce="${nonce}">${script(options.base!, kind, poll)}</script>` : ''
  }</body></html>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      ...(kind === 'asleep' || kind === 'waking' || kind === 'asleep_no_wake' ? { 'retry-after': '5' } : {})
    }
  })
}
