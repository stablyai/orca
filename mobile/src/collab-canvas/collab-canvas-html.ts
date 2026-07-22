/**
 * Offline HTML shell for the mobile collab-canvas WebView.
 * Room URI is injected at open time; engine JS is offline-bundled (E1).
 */
import { COLLAB_CANVAS_ENGINE_JS } from './collab-canvas-engine.generated'

export type CollabCanvasHtmlOptions = {
  boardId: string
  /** Full ws(s)://…/connect/<boardId> room URI (mesh node-a or override). */
  roomUri: string
}

/**
 * Build a self-contained document: no external script/CDN fetches.
 * Touch/pen events are handled by the bundled tldraw engine (pointer events).
 */
export function buildCollabCanvasHtml(options: CollabCanvasHtmlOptions): string {
  const boardId = options.boardId.replace(/[<>&"']/g, '')
  const roomUri = options.roomUri.replace(/[<>"']/g, '')
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <style>
    html, body, #root { margin: 0; padding: 0; height: 100%; width: 100%; background: #111; touch-action: none; }
    #status { position: absolute; top: 8px; left: 8px; z-index: 2; color: #aaa; font: 12px sans-serif; }
  </style>
</head>
<body>
  <div id="status">board ${boardId}</div>
  <div id="root"></div>
  <script>
    window.__ORCA_COLLAB_CANVAS__ = ${JSON.stringify({ boardId, roomUri })};
  </script>
  <script>${COLLAB_CANVAS_ENGINE_JS}</script>
  <script>
    // Engine exposes window.OrcaCollabCanvasEngine; full React mount is wired by
    // the host when RN WebView messaging is ready. Presence of the engine is
    // the E1 offline-bundle gate.
    if (!window.OrcaCollabCanvasEngine) {
      document.getElementById('status').textContent = 'collab engine missing';
    } else {
      document.getElementById('status').textContent =
        'board ' + window.__ORCA_COLLAB_CANVAS__.boardId + ' · engine ready';
    }
  </script>
</body>
</html>`
}
