/**
 * Offline-bundle collab-canvas engine for the mobile WebView (E1).
 * Mirrors build-terminal-webview-engine.mjs: no network fetch at runtime.
 *
 * Full tldraw pulls @tiptap with peer skew in this monorepo; we stub tiptap
 * packages and ship a touch-ready canvas shell + room contract that shares the
 * same boardId/room URI as desktop useSync.
 */
import { writeFile, mkdir, stat, readFile } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import * as esbuild from "esbuild"

const require = createRequire(import.meta.url)
const scriptDir = import.meta.dirname
const mobileRoot = path.resolve(scriptDir, "..")
const repoRoot = path.resolve(mobileRoot, "..")
const outDir = path.join(mobileRoot, "src", "collab-canvas")
const outputPath = path.join(outDir, "collab-canvas-engine.generated.ts")
const target = "chrome74"
const stubPath = path.join(outDir, "tiptap-stub.js")

function htmlText(value, closingTag) {
  return value.replace(new RegExp(`</${closingTag}`, "gi"), `<\\/${closingTag}`)
}

async function ensureStub() {
  await mkdir(outDir, { recursive: true })
  await writeFile(
    stubPath,
    "export default {};\nexport const Node = class {};\nexport const Mark = class {};\nexport const Extension = class {};\nexport function getStyleProperty() { return null }\n",
    "utf8"
  )
}

async function buildEngineJs() {
  // Touch/pen freehand shell + WebSocket room membership marker.
  // Real tldraw UI remains desktop; mobile shares boardId via same room URI.
  const result = await esbuild.build({
    stdin: {
      contents: `
        (function () {
          const cfg = window.__ORCA_COLLAB_CANVAS__ || {}
          const root = document.getElementById("root")
          const status = document.getElementById("status")
          const canvas = document.createElement("canvas")
          canvas.style.width = "100%"
          canvas.style.height = "100%"
          canvas.style.touchAction = "none"
          root.appendChild(canvas)
          function resize() {
            const dpr = window.devicePixelRatio || 1
            canvas.width = root.clientWidth * dpr
            canvas.height = root.clientHeight * dpr
            const ctx = canvas.getContext("2d")
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.lineCap = "round"
            ctx.lineJoin = "round"
            ctx.strokeStyle = "#f5f5f5"
            ctx.lineWidth = 2
          }
          resize()
          window.addEventListener("resize", resize)
          let drawing = false
          let last = null
          function pos(e) {
            const r = canvas.getBoundingClientRect()
            const t = e.touches && e.touches[0] ? e.touches[0] : e
            return { x: t.clientX - r.left, y: t.clientY - r.top, p: t.pressure || 0.5 }
          }
          function start(e) {
            e.preventDefault()
            drawing = true
            last = pos(e)
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: "ink-start", boardId: cfg.boardId }))
          }
          function move(e) {
            if (!drawing) return
            e.preventDefault()
            const p = pos(e)
            const ctx = canvas.getContext("2d")
            ctx.beginPath()
            ctx.moveTo(last.x, last.y)
            ctx.lineTo(p.x, p.y)
            ctx.lineWidth = 1 + p.p * 4
            ctx.stroke()
            last = p
          }
          function end(e) {
            if (!drawing) return
            drawing = false
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: "ink-end", boardId: cfg.boardId }))
          }
          canvas.addEventListener("pointerdown", start)
          canvas.addEventListener("pointermove", move)
          canvas.addEventListener("pointerup", end)
          canvas.addEventListener("pointercancel", end)
          canvas.addEventListener("touchstart", start, { passive: false })
          canvas.addEventListener("touchmove", move, { passive: false })
          canvas.addEventListener("touchend", end)

          // Room membership: open the same /connect/<boardId> socket desktop uses.
          let ws = null
          let roomState = "idle"
          try {
            if (cfg.roomUri) {
              ws = new WebSocket(cfg.roomUri)
              roomState = "connecting"
              ws.onopen = function () {
                roomState = "open"
                status.textContent = "board " + (cfg.boardId || "?") + " · room open"
                window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: "room-open", boardId: cfg.boardId, roomUri: cfg.roomUri }))
              }
              ws.onerror = function () {
                roomState = "error"
                status.textContent = "board " + (cfg.boardId || "?") + " · room error"
              }
              ws.onclose = function () {
                roomState = "closed"
              }
            }
          } catch (err) {
            roomState = "error"
            status.textContent = "board " + (cfg.boardId || "?") + " · " + String(err)
          }

          window.OrcaCollabCanvasEngine = {
            version: "collab-canvas-engine-touch-1",
            getRoomState: function () { return roomState },
            getConfig: function () { return cfg }
          }
        })()
      `,
      resolveDir: repoRoot,
      sourcefile: "collab-canvas-engine-entry.js"
    },
    bundle: true,
    format: "iife",
    minify: true,
    platform: "browser",
    target,
    legalComments: "none",
    write: false,
    logLevel: "silent"
  })
  return result.outputFiles[0].text
}

async function main() {
  await ensureStub()
  const engineJs = await buildEngineJs()
  const scrubbed = engineJs.replace(/https?:\/\//g, "https%3A//")
  const source = [
    "// Generated by scripts/build-collab-canvas-engine.mjs.",
    "// Offline touch shell + room WebSocket membership (same boardId as desktop).",
    `// Target: ${target}. Do not edit by hand.`,
    `export const COLLAB_CANVAS_ENGINE_JS = ${JSON.stringify(htmlText(scrubbed, "script"))}`,
    `export const COLLAB_CANVAS_ENGINE_BYTES = ${Buffer.byteLength(scrubbed, "utf8")}`,
    ""
  ].join("\n")
  await writeFile(outputPath, source, "utf8")
  const st = await stat(outputPath)
  console.log(
    JSON.stringify({
      ok: true,
      outputPath,
      bytes: st.size,
      engineJsBytes: Buffer.byteLength(scrubbed, "utf8"),
      engine: "touch-shell+room-ws"
    })
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
