export const TERMINAL_HTML_MESSAGE_BRIDGE_AND_DOCUMENT_CLOSE = `  function handleIncomingMessage(e) {
    var msg;
    try {
      msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch (ex) {
      return;
    }
    try {
      handleMsg(msg);
    } catch(ex) {
      reportEngineError(
        msg && msg.type === 'init' ? 'terminal init failed' : 'terminal message failed',
        ex,
        msg && msg.type === 'init' && !everReady
      );
    }
  }

  window.addEventListener('message', handleIncomingMessage);

  document.addEventListener('message', handleIncomingMessage);

  window.addEventListener('resize', function() {
    // Why: viewport changed (keyboard open/close, orientation, RN container
    // size update). Re-fit so the scale matches the new vpWidth — without
    // this, opening the keyboard leaves the terminal at the old scale even
    // though there's now less vertical room and the fit ratio may differ.
    applyFitScale('window-resize');
    adjustRowsForViewport();
    repositionOverlay();
    clampPan();
    updateTransform();
  });

  if (window.Terminal) {
    notify({ type: 'web-ready' });
  } else {
    reportEngineError('terminal engine missing', 'xterm failed to load', true);
  }
})();
</script>
</body>
</html>`
