/**
 * The page the preview rig mounts, and the artifact it mounts into it.
 *
 * No assertion and no state of its own: every origin the fixture points at is passed in, so an arm
 * that changes where a subresource lives cannot change where a link goes by accident, and the rig
 * file keeps only the arms and what they read.
 */

/** The artifact fills itself with this, so one pixel says the frame parsed and painted. */
export const ARTIFACT_RGB = '0,128,255'

/**
 * The page under test: the real web sibling, mounted by react-native-web, with nothing else on it.
 *
 * The component is imported rather than reimplemented, and `resolveExtensions` puts `.web.tsx` first
 * so this is the file the bundle ships. `renderSource` is a marker the Source case looks for.
 *
 * Wrapped in the page's own provider because the preview asks the shell what it may do
 * (`use-html-preview-link-grant.web.ts` reads `init.grants.native`), and `usePageBridgeClient`
 * throws outside one. The client is the two members that read is made of and nothing else: a fuller
 * fake would be a second implementation of the bridge, and what an arm needs to vary is the grant
 * list. `grants` defaults to carrying `externalNavigation`, which is what the session route
 * declares, so an arm that does not mention it measures the shipped screen.
 */
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

/**
 * One artifact, with every escape route a hostile one would try.
 *
 * `extra.head` and `extra.body` let a case add a `<meta refresh>` or a script without a second
 * fixture, so the thing under test is the only difference between the arms.
 */
export function artifact({ links, assets, extra = {}, nonce = 'n0', doctype = '<!doctype html>' }) {
  // Every foreign URL carries this arm's nonce, because a closed page's requests can still land and
  // a hit list shared across arms would report the previous one's fetches as this one's.
  const tag = `?n=${nonce}`
  // Subresources move to `assets` and the links do not: a case about what the policy fetches should
  // not also change which origin a tapped link navigates to.
  //
  // `doctype` is a parameter for one case's sake (C8.1 round 2): the hidden-link path reparses and
  // reserialises the artifact, and the doctype is what an engine reads its rendering mode from, so
  // an arm has to be able to hand the frame one that is not the bare name.
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

/** The inline script every arm carries, so "it did not run" is about the fence and not the fixture. */
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

/** The inline script with the origin it reaches for, so a caller never re-does the substitution. */
export function artifactScript(links) {
  return ARTIFACT_SCRIPT.replaceAll('${foreignOrigin}', links)
}
