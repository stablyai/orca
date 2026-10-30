// Pass every origin per arm so moving asset source cannot accidentally move link target; fixture owns no state/assertions.

// Solid artifact color lets one sampled pixel prove frame parsed and painted.
export const ARTIFACT_RGB = '0,128,255'

// Mount actual web component with minimal page bridge provider for init.grants.native; hook throws outside provider.
// Default externalNavigation matches session manifest; arms vary grant list without duplicating bridge behavior. renderSource marks Source view.
export const ENTRY_SOURCE = `
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Text } from 'react-native'
import { RpcClientProvider } from '../transport/client-context.web'
import {
  MobileHtmlPreview,
  MOBILE_HTML_PREVIEW_SANDBOX,
  MOBILE_HTML_PREVIEW_SEALED_SANDBOX
} from './MobileHtmlPreview'

window.__sandbox = MOBILE_HTML_PREVIEW_SANDBOX
window.__sealedSandbox = MOBILE_HTML_PREVIEW_SEALED_SANDBOX
window.__mount = (html, sandboxOverride, grants) => {
  const host = document.getElementById('root')
  const native = grants ?? ['navigate', 'storage', 'externalNavigation']
  window.__grants = native
  const client = {
    getShellSession: () => ({ grants: { native } }),
    getState: () => 'connected',
    onStateChange: () => () => {}
  }
  createRoot(host).render(
    createElement(
      RpcClientProvider,
      { client },
      createElement(MobileHtmlPreview, {
        html,
        renderSource: () => createElement(Text, null, 'SOURCE_TAB_RENDERED')
      })
    )
  )
  // A control arm needs a frame the product would never build -- one with allow-scripts -- so that
  // "the script did not run" can be told apart from "the fixture has no script". Built here rather
  // than through a prop, because the product takes no such prop and must not grow one for a test.
  //
  // Awaited rather than read straight away: createRoot().render() commits on React's own schedule,
  // and reading the element synchronously finds nothing.
  if (sandboxOverride === null) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    // Twenty seconds for a commit that takes a frame or two here: the reads this rig makes all
    // settle late on a loaded runner, which is the whole reason nothing below is timed.
    const deadline = Date.now() + 20000
    const apply = () => {
      const frame = host.querySelector('iframe')
      if (frame) {
        // A new element rather than the live one relaxed, because a live frame cannot be relaxed:
        // sandbox flags are fixed on a browsing context when it is created, and Chrome 152 keeps the
        // original ones through a srcdoc reassignment while still parsing the new document. An arm
        // that ran on such a frame reports the sealed behaviour under a widened name and passes for
        // the wrong reason, which is exactly what CI read while Chromium 147 here honoured the
        // relaxation. The clone gets its own context from creation, the way the product does it:
        // React sets the attribute before the element is inserted, and never afterwards.
        const widened = frame.cloneNode(false)
        widened.setAttribute('sandbox', sandboxOverride)
        widened.srcdoc = html
        // Resolved on the document the insertion commits, not on the insertion.
        widened.addEventListener('load', () => resolve(), { once: true })
        frame.replaceWith(widened)
        return
      }
      if (Date.now() > deadline) {
        reject(new Error('the preview never mounted a frame to override'))
        return
      }
      requestAnimationFrame(apply)
    }
    apply()
  })
}
`

// Share hostile artifact across arms; extra head/body inject script/refresh without unrelated fixture differences.
export function artifact({ links, assets, extra = {}, nonce = 'n0', doctype = '<!doctype html>' }) {
  // Nonce every foreign URL so requests arriving after prior page closes cannot contaminate next arm.
  const tag = `?n=${nonce}`
  // Keep asset origin independent of link target; doctype override exercises parser round-trip preservation beyond bare name.
  return `${doctype}<html><head><title>ARTIFACT</title>
<style>html,body{margin:0;height:100%;background:rgb(${ARTIFACT_RGB})}
#bg{background-image:url("${assets}/css-bg.png${tag}")}
@font-face{font-family:probe;src:url("${assets}/probe.woff2${tag}")}
#fonted{font-family:probe}</style>${extra.head ?? ''}</head><body>
<h1 id="marker">ARTIFACT_RENDERED</h1><div id="bg">b</div><div id="fonted">f</div>
<img id="remote" src="${assets}/img.png${tag}" />
<a id="toplink" href="${links}/tapped.html${tag}" target="_top">tap</a>
<a id="blanklink" href="${links}/blank.html${tag}" target="_blank">window</a>
<a id="rootlink" href="/" target="_top">root</a>
<a id="emptylink" href="" target="_top">empty</a>
<a id="fraglink" href="#fragtarget">contents</a><h2 id="fragtarget">F</h2>
<pre id="pre">

kept</pre>
<form id="topform" action="${links}/form.html" target="_top" method="get"><button id="submit">go</button></form>
${extra.body ?? ''}</body></html>`
}

const ARTIFACT_SCRIPT = `<script>
  // On the document element, never on a window global: a page init script owns the window of every
  // frame and runs at a moment this rig has to be able to measure rather than assume.
  document.documentElement.dataset.ran = '1';
  document.documentElement.dataset.artifactAt =
    String(Math.round(performance.now())) + ' ' + document.readyState;
  document.title = 'SCRIPT_RAN';
  document.getElementById('marker').textContent = 'SCRIPT_RAN';
  fetch('${'${foreignOrigin}'}/fetched.json').catch(() => {});
  try { window.top.location.href = '${'${foreignOrigin}'}/by-script.html' } catch (error) { document.documentElement.dataset.threw = error.name }
</script>`

export function artifactScript(links) {
  return ARTIFACT_SCRIPT.replaceAll('${foreignOrigin}', links)
}
