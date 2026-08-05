import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PNG } from 'pngjs'
import { webkit } from 'playwright'
import engine from '../../mobile/src/terminal/terminal-webview-engine.generated'

const { XTERM_ENGINE_CSS, XTERM_ENGINE_JS } = engine
const assertIntact = process.argv.includes('--assert-intact')
const labelIndex = process.argv.indexOf('--label')
const label = labelIndex >= 0 ? process.argv[labelIndex + 1] : 'latest'
const artifactDir = path.resolve('.tmp/mobile-terminal-webgl-shared-atlas', label ?? 'latest')

type Probe = {
  atlasShared: boolean
  bufferA: string[]
  bufferIntact: boolean
  rendererA: string
  rendererB: string
}

type HarnessTerminal = {
  rows: number
  buffer: {
    active: {
      getLine: (row: number) => { translateToString: () => string } | undefined
    }
  }
  loadAddon: (addon: HarnessAddon) => void
  open: (element: Element | null) => void
  refresh: (start: number, end: number) => void
  write: (data: string, done: () => void) => void
}

type HarnessAddon = {
  _renderer: { _charAtlas: unknown; constructor: { name: string } }
  clearTextureAtlas: () => void
}

type HarnessWindow = Window & {
  Terminal: new (options: Record<string, unknown>) => HarnessTerminal
  WebglAddon: { WebglAddon: new () => HarnessAddon }
  __atlasHarness: {
    a: HarnessTerminal
    b: HarnessTerminal
    addonA: HarnessAddon
    addonB: HarnessAddon
    rowB: string
    write: (term: HarnessTerminal, data: string) => Promise<void>
  }
}

function inkPixels(png: Buffer): number {
  const image = PNG.sync.read(png)
  let count = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0
    const green = image.data[offset + 1] ?? 0
    const blue = image.data[offset + 2] ?? 0
    if (red + green + blue > 90) {
      count += 1
    }
  }
  return count
}

function differingPixels(left: Buffer, right: Buffer): number {
  const a = PNG.sync.read(left)
  const b = PNG.sync.read(right)
  if (a.width !== b.width || a.height !== b.height) {
    return -1
  }
  let count = 0
  for (let offset = 0; offset < a.data.length; offset += 4) {
    if (
      a.data[offset] !== b.data[offset] ||
      a.data[offset + 1] !== b.data[offset + 1] ||
      a.data[offset + 2] !== b.data[offset + 2] ||
      a.data[offset + 3] !== b.data[offset + 3]
    ) {
      count += 1
    }
  }
  return count
}

async function main(): Promise<void> {
  await mkdir(artifactDir, { recursive: true })
  const browser = await webkit.launch({ headless: true })
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3
    })
    const page = await context.newPage()
    await page.setContent(`<!doctype html>
      <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${XTERM_ENGINE_CSS}</style>
      <style>
        html,body { margin: 0; background: #111827; }
        .terminal { width: 370px; height: 360px; overflow: hidden; }
      </style></head><body>
      <div id="a" class="terminal"></div><div id="b" class="terminal"></div>
      <script>${XTERM_ENGINE_JS}</script></body></html>`)
    // Why: tsx names serialized callbacks through this helper, which must also
    // exist inside the isolated WebKit page used by Playwright.
    await page.evaluate('globalThis.__name = (value) => value')

    await page.evaluate(async () => {
      const harnessWindow = window as unknown as HarnessWindow
      const TerminalCtor = harnessWindow.Terminal
      const WebglCtor = harnessWindow.WebglAddon.WebglAddon
      const options = {
        cols: 50,
        rows: 18,
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontSize: 13,
        cursorBlink: false,
        theme: { background: '#111827', foreground: '#f9fafb' }
      }
      const a = new TerminalCtor(options)
      const b = new TerminalCtor(options)
      const addonA = new WebglCtor()
      const addonB = new WebglCtor()
      a.loadAddon(addonA)
      b.loadAddon(addonB)
      a.open(document.querySelector('#a'))
      b.open(document.querySelector('#b'))
      const write = (term: { write: (data: string, done: () => void) => void }, data: string) =>
        new Promise<void>((resolve) => term.write(data, resolve))
      const rowA = 'relay prompt abcdefghijklmnopqrstuvwxyz 0123456789'
      const rowB = 'migration ZYXWVUTSRQPONMLKJIHGFEDCBA !?^$%&*'
      await write(a, `\x1b[2J\x1b[3J\x1b[H\x1b[?25l${rowA}\r\n`.repeat(14))
      await write(b, `\x1b[2J\x1b[3J\x1b[H\x1b[?25l${rowB}\r\n`.repeat(14))
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      harnessWindow.__atlasHarness = { a, b, addonA, addonB, rowB, write }
    })

    const terminalA = page.locator('#a .xterm-screen')
    const baseline = await terminalA.screenshot()
    await page.evaluate(async () => {
      const harness = (window as unknown as HarnessWindow).__atlasHarness
      harness.addonB.clearTextureAtlas()
      await harness.write(harness.b, `\x1b[2J\x1b[3J\x1b[H\x1b[?25l${harness.rowB}\r\n`.repeat(14))
      harness.b.refresh(0, harness.b.rows - 1)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      harness.a.refresh(0, harness.a.rows - 1)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    })

    const afterInvalidation = await terminalA.screenshot()
    const probe = await page.evaluate((): Probe => {
      const harness = (window as unknown as HarnessWindow).__atlasHarness
      const bufferA = Array.from({ length: harness.a.rows }, (_, row) =>
        harness.a.buffer.active.getLine(row)?.translateToString().trimEnd()
      )
      return {
        atlasShared: harness.addonA._renderer._charAtlas === harness.addonB._renderer._charAtlas,
        bufferA,
        bufferIntact: bufferA[0] === 'relay prompt abcdefghijklmnopqrstuvwxyz 0123456789',
        rendererA: harness.addonA._renderer.constructor.name,
        rendererB: harness.addonB._renderer.constructor.name
      }
    })
    const evidence = {
      ...probe,
      baselineInkPixels: inkPixels(baseline),
      afterInkPixels: inkPixels(afterInvalidation),
      differingPixels: differingPixels(baseline, afterInvalidation)
    }

    await writeFile(path.join(artifactDir, 'baseline.png'), baseline)
    await writeFile(path.join(artifactDir, 'after-shared-atlas-clear.png'), afterInvalidation)
    await writeFile(
      path.join(artifactDir, 'evidence.json'),
      `${JSON.stringify(evidence, null, 2)}\n`
    )
    console.log(path.join(artifactDir, 'evidence.json'))
    if (!probe.atlasShared) {
      throw new Error('WebGL terminals did not share a glyph atlas')
    }
    if (!probe.bufferIntact) {
      throw new Error('xterm buffer changed during atlas invalidation')
    }
    if (assertIntact && evidence.differingPixels !== 0) {
      throw new Error(`shared atlas invalidation changed ${evidence.differingPixels} pixels`)
    }
  } finally {
    await browser.close()
  }
}

await main()
