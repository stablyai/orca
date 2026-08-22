import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildWindowsIcoFromPng } from './trim-windows-icon-source.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(scriptDir, '..', '..')
const resourcePath = (...parts) => join(projectDir, 'resources', ...parts)
const mobileAssetPath = (...parts) => join(projectDir, 'mobile', 'assets', ...parts)

const canonicalLogo = readFileSync(resourcePath('logo.svg'), 'utf8')
const logoBody = canonicalLogo.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1]
if (!logoBody) {
  throw new Error('resources/logo.svg does not contain a readable SVG body')
}

function logoLayer(color, transform = '') {
  const recolored = logoBody.replaceAll('stroke="#53c6d8"', `stroke="${color}"`)
  return transform ? `<g transform="${transform}">${recolored}</g>` : recolored
}

function appIconSvg({ background, color }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
    <rect x="5" y="5" width="118" height="118" rx="27" fill="${background}"/>
    ${logoLayer(color, 'translate(10 10) scale(.84375)')}
  </svg>`
}

const primaryIcon = appIconSvg({ background: '#12151b', color: '#53c6d8' })
const blueIcon = appIconSvg({ background: '#1f6fff', color: '#ffffff' })
const devIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs><clipPath id="dev-tile"><rect x="5" y="5" width="118" height="118" rx="27"/></clipPath></defs>
  <rect x="5" y="5" width="118" height="118" rx="27" fill="#12151b"/>
  ${logoLayer('#53c6d8', 'translate(17 -5) scale(.82)')}
  <rect x="5" y="84" width="118" height="39" fill="#1b2028" clip-path="url(#dev-tile)"/>
  <line x1="28" y1="84" x2="100" y2="84" stroke="#53c6d8" stroke-linecap="round" stroke-opacity=".35" stroke-width="2"/>
  <text x="65" y="111" fill="#e9edf2" font-family="Arial,sans-serif" font-size="18" font-weight="700" letter-spacing="2.2" text-anchor="middle">DEV</text>
</svg>`
const adaptiveIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  ${logoLayer('#53c6d8', 'translate(26 26) scale(.59375)')}
</svg>`
const splashIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 255">
  ${logoLayer('#53c6d8', 'translate(120 47.5) scale(1.25)')}
</svg>`
const trayIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 14">
  ${logoLayer('#000000', 'translate(3.5 -2) scale(.14)')}
</svg>`

async function renderPage(browser, html, width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await page.setContent(
    `<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}svg{display:block;width:100%;height:100%}</style>${html}`
  )
  const png = await page.screenshot({ omitBackground: true })
  await page.close()
  return png
}

async function renderSvg(browser, svg, width, height, outputPath) {
  const png = await renderPage(browser, svg, width, height)
  writeFileSync(outputPath, png)
  return png
}

function encodeIcns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}

async function renderIcns(browser) {
  const specifications = [
    ['icp4', 16],
    ['ic11', 32],
    ['icp5', 32],
    ['ic12', 64],
    ['icp6', 64],
    ['ic07', 128],
    ['ic13', 256],
    ['ic08', 256],
    ['ic14', 512],
    ['ic09', 512],
    ['ic10', 1024]
  ]
  const entries = []
  for (const [type, size] of specifications) {
    entries.push({ type, png: await renderPage(browser, primaryIcon, size, size) })
  }
  writeFileSync(resourcePath('build', 'icon.icns'), encodeIcns(entries))
}

async function renderWatercolorIcon(browser) {
  const background = readFileSync(
    resourcePath('icon-source', 'watercolor-background.png')
  ).toString('base64')
  const overlay = `<div style="position:relative;width:100%;height:100%">
    <img src="data:image/png;base64,${background}" style="position:absolute;inset:0;width:100%;height:100%;clip-path:inset(3.5% round 20%);object-fit:cover"/>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" style="position:absolute;inset:0">
      ${logoLayer('#e9edf2', 'translate(10 10) scale(.84375)')}
    </svg>
  </div>`
  const png = await renderPage(browser, overlay, 1024, 1024)
  writeFileSync(resourcePath('app-icons', 'mcode-watercolor.png'), png)
  return png
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    const buildPng = await renderSvg(
      browser,
      primaryIcon,
      1024,
      1024,
      resourcePath('build', 'icon.png')
    )
    writeFileSync(resourcePath('build', 'icon.ico'), buildWindowsIcoFromPng(buildPng))
    const desktopPng = await renderPage(browser, primaryIcon, 256, 256)
    writeFileSync(resourcePath('icon.png'), desktopPng)
    await renderSvg(browser, devIcon, 256, 256, resourcePath('icon-dev.png'))
    const devBuildPng = await renderPage(browser, devIcon, 1024, 1024)
    writeFileSync(resourcePath('build', 'icon-dev.ico'), buildWindowsIcoFromPng(devBuildPng))
    const bluePng = await renderSvg(
      browser,
      blueIcon,
      1024,
      1024,
      resourcePath('app-icons', 'mcode-blue.png')
    )
    writeFileSync(resourcePath('app-icons', 'mcode-blue.ico'), buildWindowsIcoFromPng(bluePng))
    const watercolorPng = await renderWatercolorIcon(browser)
    writeFileSync(
      resourcePath('app-icons', 'mcode-watercolor.ico'),
      buildWindowsIcoFromPng(watercolorPng)
    )
    await renderSvg(browser, primaryIcon, 1024, 1024, mobileAssetPath('icon.png'))
    await renderSvg(browser, adaptiveIcon, 1024, 1024, mobileAssetPath('adaptive-icon.png'))
    await renderSvg(browser, splashIcon, 400, 255, mobileAssetPath('splash-icon.png'))
    await renderSvg(browser, primaryIcon, 48, 48, mobileAssetPath('favicon.png'))
    await renderSvg(browser, trayIcon, 22, 14, resourcePath('tray', 'mcode-menu-barTemplate.png'))
    await renderSvg(
      browser,
      trayIcon,
      44,
      28,
      resourcePath('tray', 'mcode-menu-barTemplate@2x.png')
    )
    await renderIcns(browser)
  } finally {
    await browser.close()
  }
}

await main()
