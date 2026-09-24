/**
 * The elements the document's modules reach for by id: the surface xterm is opened on, the
 * scroll indicator, and the selection overlay with its two handles and its menu pill.
 *
 * They are read as the modules are parsed, so whatever hosts the document — the WebView's body
 * or the page's own container — has to have planted this first.
 */
export const TERMINAL_DOCUMENT_MARKUP = `<div id="terminal-container">
  <div id="terminal-surface"></div>
</div>
<div id="scroll-indicator"><div id="scroll-thumb"></div></div>
<div id="selection-overlay">
  <div id="sel-handle-start" class="sel-handle start"></div>
  <div id="sel-handle-end" class="sel-handle end"></div>
  <div id="sel-menu">
    <button id="sel-menu-copy">Copy</button>
    <button id="sel-menu-all">Select All</button>
  </div>
</div>`
