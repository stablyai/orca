import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { runBrowserRouteEgressElectron } from '../../network/egress/browser-route-egress-electron-launch'

const MAIN = String.raw`
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { routePageTextInsertion } from './src/main/browser/cdp/input/guest-direct-key-input'
if (process.platform === 'darwin') app.setActivationPolicy('accessory')
app.commandLine.appendSwitch('site-per-process')
const { resultPath, scenario } = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const answer = (value) => { writeFileSync(resultPath, JSON.stringify(value)); app.exit(0) }
app.whenReady().then(async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(req.url === '/frame' ? '<textarea id="field"></textarea>' :
      '<textarea id="field"></textarea><iframe src="http://localhost:' + server.address().port + '/frame"></iframe>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const win = new BrowserWindow({ show: false, width: 960, height: 640,
    webPreferences: { offscreen: true, webviewTag: true } })
  const attached = new Promise(resolve => win.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)))
  await win.loadURL('data:text/html,' + encodeURIComponent('<textarea id="draft">Unsent draft</textarea>' +
    '<webview style="width:800px;height:500px" src="http://127.0.0.1:' + server.address().port + '/"></webview>'))
  const guest = await attached
  if (guest.isLoading()) await new Promise(resolve => guest.once('did-finish-load', resolve))
  let crashed = false
  guest.on('render-process-gone', () => { crashed = true })
  guest.debugger.attach('1.3')
  const send = (method, params, sessionId) => guest.debugger.sendCommand(method, params, sessionId)
  const insert = async text => (await routePageTextInsertion(guest, send)).deliver({ text })
  await guest.executeJavaScript('field.focus()')
  if (scenario.startsWith('child-')) {
    const childServer = createServer((_req,res) => {
      res.setHeader('Content-Type','text/html')
      res.end('<textarea id="field"></textarea>')
    })
    await new Promise(resolve => childServer.listen(0,'127.0.0.1',resolve))
    const loaded = new Promise(resolve => guest.once('did-frame-finish-load',resolve))
    await guest.executeJavaScript('document.querySelector("iframe").src="http://127.0.0.1:' + childServer.address().port + '/";void 0')
    await loaded
    const { frameTree } = await send('Page.getFrameTree',{})
    const frameId = frameTree.childFrames[0].frame.id
    const { executionContextId } = await send('Page.createIsolatedWorld',{frameId,worldName:'fixture-child'})
    const child = expression => send('Runtime.evaluate',{expression,contextId:executionContextId,returnByValue:true})
    const { targetInfos } = await send('Target.getTargets',{})
    if (targetInfos.some(target => target.type === 'iframe' && target.targetId === frameId)) throw Error('Fixture child must share the root renderer')
    await child('field.focus()')
    if (scenario === 'child-focus-race') await child("document.designMode='on';document.body.innerHTML='';document.body.focus()")
    await win.webContents.executeJavaScript('draft.focus()')
    const route = await routePageTextInsertion(guest,send)
    if (scenario === 'child-focus-race') await guest.executeJavaScript('field.focus()')
    if (scenario === 'child-detached') await guest.executeJavaScript('document.querySelector("iframe").remove()')
    if (scenario === 'child-navigation') {
      const reloaded = new Promise(resolve => guest.once('did-frame-finish-load',resolve))
      await guest.executeJavaScript('document.querySelector("iframe").src+="?new";void 0')
      await reloaded
    }
    if (scenario === 'child-expired') {
      const busy = new Promise(resolve => guest.once('console-message',resolve))
      void child("console.log('busy');{const end=performance.now()+11000;while(performance.now()<end){}}")
      await busy
    }
    let outcome = 'ok'
    try { await route.deliver({text:'Child 🙏'}) } catch(error) {outcome=error.code}
    const after = scenario === 'child-detached' ? null : scenario === 'child-navigation'
      ? await guest.mainFrame.frames[0].executeJavaScript('field.value')
      : (await child(scenario === 'child-focus-race' ? 'document.body.textContent' : 'field.value')).result.value
    await guest.executeJavaScript('field.focus()')
    await insert('Next 🙏')
    const result = {outcome,after,root:await guest.executeJavaScript('field.value'),host:await win.webContents.executeJavaScript('draft.value'),hostFocus:await win.webContents.executeJavaScript('document.activeElement.id')}
    guest.debugger.detach()
    win.destroy()
    answer(result)
    return
  }
  if (scenario === 'editing') {
    await guest.executeJavaScript("field.value='Replace me';field.setSelectionRange(0,10);window.inputText='';field.addEventListener('input',()=>{inputText=field.value})")
    await insert('First\nSecond 🙏')
    const selection = await guest.executeJavaScript('field.value')
    const inputText = await guest.executeJavaScript('inputText')
    await guest.executeJavaScript("document.execCommand('undo')")
    const undo = await guest.executeJavaScript('field.value')
    await guest.executeJavaScript("field.addEventListener('beforeinput', e => e.preventDefault(), {once:true})")
    await insert('Cancelled')
    const cancelled = await guest.executeJavaScript('field.value')
    await guest.executeJavaScript("const rich=document.createElement('div');rich.id='rich';rich.contentEditable='true';document.body.append(rich);rich.focus()")
    await insert('Rich 🙏')
    const rich = await guest.executeJavaScript('rich.textContent')
    await guest.executeJavaScript("const host=document.createElement('div');host.id='shadow';document.body.append(host);host.attachShadow({mode:'open'}).innerHTML='<textarea></textarea>';host.shadowRoot.firstChild.focus()")
    await insert('Shadow')
    const shadow = await guest.executeJavaScript('shadow.shadowRoot.firstChild.value')
    await guest.executeJavaScript("const frame=document.createElement('iframe');frame.id='local';document.body.append(frame);frame.contentDocument.body.innerHTML='<textarea id=localfield></textarea>';frame.contentDocument.querySelector('textarea').focus();Date.now=()=>0;Document.prototype.execCommand=()=>{throw Error('page hook ran')};frame.contentWindow.Document.prototype.execCommand=()=>{throw Error('child hook ran')};void 0")
    await insert('Local 🙏')
    const local = await guest.executeJavaScript('local.contentDocument.querySelector("textarea").value')
    await guest.executeJavaScript("local.contentDocument.designMode='on';local.contentDocument.body.innerHTML='';local.contentWindow.focus()")
    await insert('Design')
    const design = await guest.executeJavaScript('local.contentDocument.body.textContent')
    await guest.executeJavaScript("field.focus();field.addEventListener('beforeinput',()=>shadow.shadowRoot.firstChild.focus(),{once:true})")
    let moved = 'ok'
    try { await insert('Wrong target') } catch(error) { moved=error.code }
    await guest.executeJavaScript("document.body.innerHTML='';document.body.contentEditable='true';document.body.focus()")
    await insert('Body 🙏')
    const body = await guest.executeJavaScript('document.body.textContent')
    answer({ selection, inputText, undo, cancelled, rich, shadow, local, design, moved, body,
      host: await win.webContents.executeJavaScript('draft.value') })
    return
  }
  if (scenario === 'detached') {
    await guest.executeJavaScript("const frame=document.createElement('iframe');frame.id='local';document.body.append(frame);frame.contentDocument.body.innerHTML='<textarea></textarea>';frame.contentDocument.querySelector('textarea').focus()")
  }
  const route = await routePageTextInsertion(guest, send)
  if (scenario === 'focus-race') {
    const { targetInfos } = await send('Target.getTargets', {})
    const target = targetInfos.find(info => info.type === 'iframe')
    if (!target) throw new Error('Cross-site frame target missing')
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const { root } = await send('DOM.getDocument', {}, sessionId)
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#field' }, sessionId)
    await send('DOM.focus', { nodeId }, sessionId)
  } else if (scenario === 'navigation') {
    await guest.loadURL('http://127.0.0.1:' + server.address().port + '/')
    await guest.executeJavaScript('field.focus()')
  } else if (scenario === 'detached') {
    await guest.executeJavaScript('local.remove()')
  } else if (scenario === 'handler-expired') {
    await guest.executeJavaScript("field.addEventListener('beforeinput',()=>{const end=performance.now()+11000;while(performance.now()<end){}},{once:true})")
  } else {
    const busy = new Promise(resolve => guest.once('console-message', resolve))
    void guest.executeJavaScript("Date.now=()=>0;console.log('busy');{const end=performance.now()+11000;while(performance.now()<end){}};void 0").catch(() => {})
    await busy
  }
  let outcome = 'ok'
  const delivered = route.deliver({ text: 'LATE' })
  if (scenario === 'renderer-dies') guest.forcefullyCrashRenderer()
  try { await delivered } catch (error) { outcome = error.code }
  if (scenario === 'renderer-dies') {
    answer({ outcome, host: await win.webContents.executeJavaScript('draft.value') })
    return
  }
  if (crashed) { answer({ crashed, outcome }); return }
  const after = await guest.executeJavaScript('field.value')
  await guest.executeJavaScript('field.focus()')
  const next = await routePageTextInsertion(guest, send)
  await next.deliver({ text: 'Next 🙏' })
  answer({ crashed, outcome, after, next: await guest.executeJavaScript('field.value'),
    host: await win.webContents.executeJavaScript('draft.value') })
}).catch(error => answer({ error: String(error.stack || error) }))
`

it.each([
  'focus-race',
  'expired',
  'navigation',
  'detached',
  'editing',
  'handler-expired',
  'renderer-dies',
  'child-insert',
  'child-focus-race',
  'child-expired',
  'child-navigation',
  'child-detached'
])(
  'handles %s input without leaking or replaying abandoned text',
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-guest-text-'))
    try {
      const mainPath = join(root, 'main.cjs')
      await build({
        stdin: { contents: MAIN, resolveDir: process.cwd(), loader: 'ts' },
        outfile: mainPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron', '*.node']
      })
      writeFileSync(
        join(root, 'config.json'),
        JSON.stringify({ resultPath: join(root, 'result.json'), scenario })
      )
      const result = await runBrowserRouteEgressElectron(root, mainPath)
      if (scenario.startsWith('child-')) {
        expect(result).toEqual({
          outcome:
            scenario === 'child-insert'
              ? 'ok'
              : scenario === 'child-expired'
                ? 'browser_timeout'
                : 'browser_input_target_unavailable',
          after:
            scenario === 'child-insert' ? 'Child 🙏' : scenario === 'child-detached' ? null : '',
          root: 'Next 🙏',
          host: 'Unsent draft',
          hostFocus: 'draft'
        })
        return
      }
      if (scenario === 'editing') {
        expect(result).toEqual({
          selection: 'First\nSecond 🙏',
          inputText: 'First\nSecond 🙏',
          undo: 'Replace me',
          cancelled: 'Replace me',
          rich: 'Rich 🙏',
          shadow: 'Shadow',
          local: 'Local 🙏',
          design: 'Design',
          moved: 'browser_input_target_unavailable',
          body: 'Body 🙏',
          host: 'Unsent draft'
        })
        return
      }
      if (scenario === 'renderer-dies') {
        expect(result).toEqual({ outcome: 'browser_error', host: 'Unsent draft' })
        return
      }
      expect(result).toEqual({
        crashed: false,
        outcome: scenario.endsWith('expired')
          ? 'browser_timeout'
          : 'browser_input_target_unavailable',
        after: '',
        next: 'Next 🙏',
        host: 'Unsent draft'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  45_000
)
