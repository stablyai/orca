/**
 * Offline collab-canvas engine for mobile WebView (E1).
 * Bundles @tldraw/store + @tldraw/sync-core + @tldraw/tlschema (NOT full tldraw —
 * that pulls broken tiptap peers). Puts freehand strokes as geo shapes into the
 * SAME node-a sync room desktop CollabCanvas uses, so ink is cross-visible.
 */
import { writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import * as esbuild from 'esbuild'

const scriptDir = import.meta.dirname
const mobileRoot = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(mobileRoot, '..')
const outDir = path.join(mobileRoot, 'src', 'collab-canvas')
const outputPath = path.join(outDir, 'collab-canvas-engine.generated.ts')
const target = 'chrome74'

function htmlText(value, closingTag) {
  return value.replace(new RegExp(`</${closingTag}`, 'gi'), `<\\/${closingTag}`)
}

async function buildEngineJs() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        import { createTLSchema } from '@tldraw/tlschema'
        import { Store } from '@tldraw/store'
        import { TLSyncClient, ClientWebSocketAdapter } from '@tldraw/sync-core'
        import { atom } from '@tldraw/state'

        (function boot() {
          const cfg = window.__ORCA_COLLAB_CANVAS__ || {}
          const root = document.getElementById('root')
          const status = document.getElementById('status')
          const canvas = document.createElement('canvas')
          canvas.style.cssText = 'width:100%;height:100%;touch-action:none;display:block'
          root.appendChild(canvas)
          const dpr = window.devicePixelRatio || 1
          function resize() {
            canvas.width = root.clientWidth * dpr
            canvas.height = root.clientHeight * dpr
            const ctx = canvas.getContext('2d')
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'
            ctx.strokeStyle = '#f5f5f5'
            ctx.lineWidth = 2
          }
          resize()
          window.addEventListener('resize', resize)

          const schema = createTLSchema()
          const store = new Store({ schema, props: {} })
          const uri = cfg.roomUri
          const socket = new ClientWebSocketAdapter(() => uri)
          const presence = atom('presence', null)
          const presenceMode = atom('presenceMode', 'full')
          let connected = false
          const client = new TLSyncClient({
            store,
            socket,
            presence,
            presenceMode,
            onLoad() {},
            onSyncError(r) {
              status.textContent = 'sync error: ' + r
            },
            onAfterConnect() {
              connected = true
              status.textContent = 'board ' + (cfg.boardId || '?') + ' · room synced'
              window.ReactNativeWebView &&
                window.ReactNativeWebView.postMessage(
                  JSON.stringify({ type: 'room-open', boardId: cfg.boardId, roomUri: uri })
                )
            }
          })

          // Remote shapes → local canvas (simple rect markers)
          function redrawRemote() {
            const ctx = canvas.getContext('2d')
            // don't clear local stroke mid-draw; full redraw of remote geos only at end
          }

          store.listen(() => {
            // Remote ink: draw geo shapes that are not local freehand
            const ctx = canvas.getContext('2d')
            // leave local strokes; paint remote markers as outlines
            for (const r of store.allRecords()) {
              if (r.typeName !== 'shape' || r.type !== 'geo') continue
              if (r.meta && r.meta.localStroke) continue
              ctx.save()
              ctx.strokeStyle = '#6af'
              ctx.strokeRect(r.x, r.y, r.props?.w || 40, r.props?.h || 40)
              ctx.restore()
            }
          })

          let drawing = false
          let last = null
          let stroke = []
          function pos(e) {
            const r = canvas.getBoundingClientRect()
            const t = e.touches && e.touches[0] ? e.touches[0] : e
            return { x: t.clientX - r.left, y: t.clientY - r.top }
          }
          function start(e) {
            e.preventDefault()
            drawing = true
            last = pos(e)
            stroke = [last]
            window.ReactNativeWebView &&
              window.ReactNativeWebView.postMessage(
                JSON.stringify({ type: 'ink-start', boardId: cfg.boardId })
              )
          }
          function move(e) {
            if (!drawing) return
            e.preventDefault()
            const p = pos(e)
            const ctx = canvas.getContext('2d')
            ctx.beginPath()
            ctx.moveTo(last.x, last.y)
            ctx.lineTo(p.x, p.y)
            ctx.stroke()
            last = p
            stroke.push(p)
          }
          function end(e) {
            if (!drawing) return
            drawing = false
            // Commit stroke as a geo bounding box into the shared sync room
            if (!connected || stroke.length === 0) return
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
            for (const p of stroke) {
              minX = Math.min(minX, p.x)
              minY = Math.min(minY, p.y)
              maxX = Math.max(maxX, p.x)
              maxY = Math.max(maxY, p.y)
            }
            const w = Math.max(8, maxX - minX)
            const h = Math.max(8, maxY - minY)
            const page = store.allRecords().find((r) => r.typeName === 'page')
            const pageId = page?.id || 'page:page'
            const id = 'shape:mobile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
            try {
              store.put([
                {
                  id,
                  typeName: 'shape',
                  type: 'geo',
                  x: minX,
                  y: minY,
                  rotation: 0,
                  index: 'a1',
                  parentId: pageId,
                  isLocked: false,
                  opacity: 1,
                  props: {
                    geo: 'rectangle',
                    w,
                    h,
                    color: 'blue',
                    fill: 'none',
                    dash: 'draw',
                    size: 'm',
                    font: 'draw',
                    align: 'middle',
                    verticalAlign: 'middle',
                    growY: 0,
                    scale: 1,
                    url: '',
                    labelColor: 'black',
                    richText: {
                      type: 'doc',
                      content: [
                        {
                          type: 'paragraph',
                          content: [{ type: 'text', text: 'mobile-ink' }]
                        }
                      ]
                    }
                  },
                  meta: { localStroke: true, source: 'mobile-engine' }
                }
              ])
              window.ReactNativeWebView &&
                window.ReactNativeWebView.postMessage(
                  JSON.stringify({
                    type: 'ink-end',
                    boardId: cfg.boardId,
                    shapeId: id,
                    synced: true
                  })
                )
            } catch (err) {
              status.textContent = 'put failed: ' + err
              window.ReactNativeWebView &&
                window.ReactNativeWebView.postMessage(
                  JSON.stringify({ type: 'ink-end', boardId: cfg.boardId, synced: false, error: String(err) })
                )
            }
          }
          canvas.addEventListener('pointerdown', start)
          canvas.addEventListener('pointermove', move)
          canvas.addEventListener('pointerup', end)
          canvas.addEventListener('pointercancel', end)
          canvas.addEventListener('touchstart', start, { passive: false })
          canvas.addEventListener('touchmove', move, { passive: false })
          canvas.addEventListener('touchend', end)

          window.OrcaCollabCanvasEngine = {
            version: 'collab-canvas-engine-sync-2',
            getConnected: () => connected,
            getConfig: () => cfg,
            getRecordCount: () => store.allRecords().length,
            close: () => {
              try { client.close() } catch {}
              try { socket.close() } catch {}
            }
          }
        })()
      `,
      resolveDir: repoRoot,
      sourcefile: 'collab-canvas-engine-entry.js'
    },
    bundle: true,
    format: 'iife',
    minify: true,
    platform: 'browser',
    target,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
    // Resolve from monorepo node_modules
    nodePaths: [path.join(repoRoot, 'node_modules'), '/home/nixos/orca-src/node_modules']
  })
  return result.outputFiles[0].text
}

async function main() {
  await mkdir(outDir, { recursive: true })
  const engineJs = await buildEngineJs()
  const scrubbed = engineJs // keep protocol strings intact for sync
  const source = [
    '// Generated by scripts/build-collab-canvas-engine.mjs.',
    '// Offline TLSyncClient + touch freehand → geo shapes in shared room.',
    `// Target: ${target}. Do not edit by hand.`,
    `export const COLLAB_CANVAS_ENGINE_JS = ${JSON.stringify(htmlText(scrubbed, 'script'))}`,
    `export const COLLAB_CANVAS_ENGINE_BYTES = ${Buffer.byteLength(scrubbed, 'utf8')}`,
    ''
  ].join('\\n')
  await writeFile(outputPath, source, 'utf8')
  const st = await stat(outputPath)
  console.log(
    JSON.stringify({
      ok: true,
      outputPath,
      bytes: st.size,
      engineJsBytes: Buffer.byteLength(scrubbed, 'utf8'),
      engine: 'tlsync+touch-geo'
    })
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
