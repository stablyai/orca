// Re-records src/shared/theme/__fixtures__/css-color-probe-chromium.json: what Chromium's canvas
// probe (browserColorProbe) returns for a fixed corpus plus every built-in token value. Run it
// against a dev Orca started with remote debugging after an Electron upgrade:
//   node config/scripts/theme/record-css-color-probe-fixture.mjs <cdp-port>
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const THEME_DIR = path.join(REPO_ROOT, 'src', 'shared', 'theme')
const OUTPUT = path.join(THEME_DIR, '__fixtures__', 'css-color-probe-chromium.json')

function corpus() {
  const named = readFileSync(path.join(THEME_DIR, 'css-named-colors.ts'), 'utf8')
    .match(/[a-z]+:[0-9a-f]{6}/g)
    .map((entry) => entry.split(':')[0])
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = (n) => Math.round(rand() * n * 100) / 100
  const fixed = JSON.parse(
    readFileSync(path.join(import.meta.dirname, 'css-color-probe-corpus.json'), 'utf8')
  )
  const random = []
  for (let i = 0; i < 60; i++) {
    random.push(`rgb(${pick(255)} ${pick(255)} ${pick(255)} / ${pick(1)})`)
    random.push(`oklch(${pick(1)} ${pick(0.35)} ${pick(360)})`)
    random.push(
      `color-mix(in srgb, oklch(${pick(1)} ${pick(0.3)} ${pick(360)}) ${Math.round(pick(100))}%, #${Math.floor(
        rand() * 16777215
      )
        .toString(16)
        .padStart(6, '0')})`
    )
    random.push(`hsl(${pick(360)} ${pick(100)}% ${pick(100)}% / ${pick(1)})`)
    random.push(`lab(${pick(100)} ${pick(200) - 100} ${pick(200) - 100})`)
  }
  const generated = readFileSync(path.join(THEME_DIR, 'theme-built-in-values.generated.ts'), 'utf8')
  const builtIns = [...generated.matchAll(/'--[\w-]+': '([^']*)'/g)].map((match) => match[1])
  return [...new Set([...named, ...fixed, ...random, ...builtIns])]
}

async function evaluate(port, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((target) => target.type === 'page')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  socket.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    })
  )
  return await new Promise((resolve) =>
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id === 1) {
        socket.close()
        resolve(message.result.result.value)
      }
    })
  )
}

const port = process.argv[2]
if (!port) {
  console.error('Usage: record-css-color-probe-fixture.mjs <cdp-port>')
  process.exit(1)
}
const inputs = corpus()
// Same steps as browserColorProbe in src/renderer/src/app-shell/appearance/plugin-theme-tokens.ts.
const result = await evaluate(
  port,
  `(() => {
    const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
    const probe = (value) => {
      if (!CSS.supports('color', value)) return null
      const paint = (seed) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = seed; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
      const first = paint('#000000'); const second = paint('#ffffff')
      if (first.some((channel, index) => channel !== second[index])) return null
      return [first[0], first[1], first[2], first[3] / 255]
    }
    return { version: navigator.userAgent.match(/Chrome\\/[\\d.]+/)[0], rows: ${JSON.stringify(inputs)}.map((value) => [value, probe(value)]) }
  })()`
)
writeFileSync(
  OUTPUT,
  `${JSON.stringify({ source: `${result.version} OffscreenCanvas probe, as browserColorProbe`, rows: result.rows }).replace(/\],\[/g, '],\n[')}\n`
)
console.log(`wrote ${path.relative(REPO_ROOT, OUTPUT)} (${result.rows.length} rows)`)
