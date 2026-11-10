// Headless helpers over Metro's CDP for the Orca mobile dev client on a simulator (no GUI).
// Adapted from W8/gap5's /tmp/w8/cdp-*.mjs. Port: W9M_METRO_PORT (default 8131).
//   node cdp.mjs identity-install <file>  stores {seedB64, enrollment} as the app's Orca Cloud identity
//   node cdp.mjs identity-clear           removes the stored identity (the app makes a fresh, unenrolled key)
//   node cdp.mjs texts <needle>           rendered text strings containing <needle> (read-only)
//   node cdp.mjs eval '<expr>'
// Hermes's CDP does not await promises: the result is parked on a global and read back.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(resolve(here, '../../../../mobile/package.json'))
const WebSocket = require('ws')
const PORT = process.env.W9M_METRO_PORT ?? '8131'
const KEY = 'orca.cloud-device.v1'
const [mode, arg] = process.argv.slice(2)

async function session() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const target = targets.find((t) => t.appId === 'com.stably.orca.mobile') ?? targets[0]
  if (!target) {
    throw new Error('no CDP target (is the app running?)')
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, fail) => {
    ws.on('open', ok)
    ws.on('error', fail)
  })
  let n = 0
  const pending = new Map()
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data))
    pending.get(msg.id)?.(msg)
  })
  const evaluate = (expression) =>
    new Promise((ok) => {
      const id = ++n
      pending.set(id, ok)
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    }).then((m) => m.result?.result?.value ?? m.result?.exceptionDetails?.text ?? null)
  return { evaluate, close: () => ws.close() }
}

const timer = setTimeout(() => {
  console.log('"cdp timeout"')
  process.exit(2)
}, 20000)
const s = await session()
try {
  if (mode === 'identity-install' || mode === 'identity-clear') {
    const value = mode === 'identity-install' ? readFileSync(arg, 'utf8') : null
    await s.evaluate(`(function () {
      globalThis.__w9Identity = { pending: true }
      var m = globalThis.expo && globalThis.expo.modules && globalThis.expo.modules.ExpoSecureStore
      if (!m) { globalThis.__w9Identity = { error: 'no ExpoSecureStore' }; return }
      var options = { keychainAccessible: m.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
      var work = ${JSON.stringify(value)} === null
        ? m.deleteValueWithKeyAsync(${JSON.stringify(KEY)}, options)
        : m.setValueWithKeyAsync(${JSON.stringify(value)}, ${JSON.stringify(KEY)}, options)
      work.then(function () { globalThis.__w9Identity = { ok: true } }, function (e) { globalThis.__w9Identity = { error: String(e) } })
    })()`)
    await new Promise((r) => setTimeout(r, 1500))
    console.log(await s.evaluate('JSON.stringify(globalThis.__w9Identity)'))
  } else if (mode === 'texts') {
    console.log(
      await s.evaluate(`(() => {
      const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__
      if (!hook) return '"no hook"'
      const out = new Set()
      const take = (v) => {
        if (typeof v === 'string' && v.includes(${JSON.stringify(arg ?? '')})) out.add(v)
        else if (Array.isArray(v)) v.forEach(take)
      }
      for (const id of hook.renderers.keys()) {
        const roots = hook.getFiberRoots(id)
        roots && roots.forEach((r) => {
          const stack = [r.current]
          while (stack.length) {
            const f = stack.pop()
            if (!f) continue
            if (f.memoizedProps) { take(f.memoizedProps.children); take(f.memoizedProps.text); take(f.memoizedProps.accessibilityLabel) }
            if (f.child) stack.push(f.child)
            if (f.sibling) stack.push(f.sibling)
          }
        })
      }
      return JSON.stringify([...out].slice(0, 80))
    })()`)
    )
  } else if (mode === 'eval') {
    console.log(JSON.stringify(await s.evaluate(arg)))
  } else {
    console.log('usage: cdp.mjs identity-install <file> | identity-clear | texts <needle> | eval <expr>')
  }
} finally {
  s.close()
  clearTimeout(timer)
}
process.exit(0)
