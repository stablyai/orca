// Plant markup before document startup reads its host-scoped elements.
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
