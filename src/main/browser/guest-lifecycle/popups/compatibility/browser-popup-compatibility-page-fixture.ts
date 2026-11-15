export function popupFixtureHtml(origin: string): string {
  return `<!doctype html><meta name="referrer" content="strict-origin-when-cross-origin"><body>
    <button id="oauth" onclick="window.popup=window.open('/authorize?client_id=synthetic&amp;redirect_uri=${origin}/callback&amp;response_type=code');document.body.dataset.handle=String(!!window.popup)">OAuth</button>
    <button id="blank" onclick="window.popup=window.open('about:blank#state');document.body.dataset.handle=String(!!window.popup);if(window.popup)window.popup.eval(&quot;window.opener.postMessage('blank:'+document.cookie,'*')&quot;)">Blank</button>
    <button id="invalid" onclick="window.popup=window.open('about:blank?state=synthetic');document.body.dataset.handle=String(!!window.popup)">Invalid</button>
    <button id="burst" onclick="window.handles=Array.from({length:5},()=>window.open('about:blank'));document.body.dataset.handles=JSON.stringify(window.handles.map(Boolean))">Burst</button>
    <button id="stale" onclick="document.body.dataset.handle='waiting';setTimeout(()=>{window.popup=window.open('about:blank');document.body.dataset.handle=String(!!window.popup)},1100)">Stale</button>
    <form method="post" target="_blank" action="/post"><input name="code" value="synthetic+value"><button id="post">POST</button></form>
    <form method="post" target="_blank" action="/multipart" enctype="multipart/form-data"><input name="code" value="synthetic-multipart"><button id="multipart">Multipart</button></form>
    <form method="post" target="_blank" action="/empty"><button id="empty">Empty POST</button></form>
    <a id="link" href="/docs" target="_blank">Docs</a>
    <a id="oauth-link" href="/authorize-link?client_id=synthetic&amp;redirect_uri=${origin}/callback&amp;response_type=code" target="_blank">OAuth link</a>
    <a id="background" href="/background">Background</a>
    <a id="shift" href="/shift">Popup link</a>
    <script>window.addEventListener('message',event=>document.body.dataset.message=event.data)</script>
  </body>`
}
